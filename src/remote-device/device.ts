#!/usr/bin/env node

import { RemoteChannel, type AuthSession } from './remote-channel.js';
import { DeviceAuthenticator } from './device-authenticator.js';
import { DesktopCommanderIntegration } from './desktop-commander-integration.js';
import { fileURLToPath } from 'url';
import os from 'os';
import fs from 'fs/promises';
import path from 'path';
import { captureRemote } from '../utils/capture.js';

export interface MCPDeviceOptions {
    persistSession?: boolean;
}

/**
 * How many recently-handled call ids to remember for duplicate-delivery
 * suppression. The two transports deliver a call within MILLISECONDS of each
 * other, so this only has to outlive that window — 100 ids is several minutes
 * of even the heaviest agent traffic, and costs ~10 KB on the user's machine
 * (the device process, not the shared server).
 */
const SEEN_CALL_IDS_MAX = 100;
const PERSISTED_DEVICE_LOOKUP_ATTEMPTS = 3;
const PERSISTED_DEVICE_LOOKUP_RETRY_MS = 250;

export function getRemoteDeviceConfigPath() {
    return path.join(os.homedir(), '.desktop-commander-device', 'device.json');
}

type PersistedSession = Pick<AuthSession, 'access_token' | 'refresh_token'>;

export interface PersistedDeviceConfig {
    deviceId?: string;
    session: PersistedSession | null;
}

/**
 * Replace the device session file atomically. A refresh token is single-use and
 * rotates over time, so exposing a truncated write or losing the completed
 * rename can force an otherwise healthy restart back through browser approval.
 */
export async function writeRemoteDeviceConfigAtomically(
    configPath: string,
    config: PersistedDeviceConfig
): Promise<void> {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const tempPath = `${configPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
        await fs.writeFile(tempPath, JSON.stringify(config, null, 2), {
            encoding: 'utf8',
            mode: 0o600,
        });

        const maxAttempts = os.platform() === 'win32' ? 50 : 1;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                await fs.rename(tempPath, configPath);
                break;
            } catch (error: any) {
                const transient = ['EPERM', 'EACCES', 'EBUSY'].includes(error?.code);
                if (!transient || attempt === maxAttempts) throw error;
                await new Promise(resolve => setTimeout(resolve, Math.min(5 * attempt, 100)));
            }
        }
    } finally {
        await fs.rm(tempPath, { force: true }).catch(() => { });
    }
}

export class MCPDevice {
    private baseServerUrl: string;
    private remoteChannel: RemoteChannel;
    private deviceId?: string;
    private isShuttingDown: boolean;
    private configPath: string;
    private persistSession: boolean;
    private desktop: DesktopCommanderIntegration;
    /** Call ids already handled by THIS process (insertion-ordered, bounded). */
    private seenCallIds: Set<string> = new Set();
    /** One serialized recovery loop for the local stdio child. */
    private localRecoveryPromise: Promise<void> | null = null;
    /** Backoff survives quick crash/recovery cycles and resets after stable uptime. */
    private localRestartAttempt = 0;
    private localMcpStableSince = 0;
    /** Session-file mutations are ordered so the newest rotated token wins. */
    private configWriteChain: Promise<void> = Promise.resolve();
    /** Invalidates queued writes when a revoked device config is cleared. */
    private configWriteGeneration = 0;
    /** Prevents an obsolete auth callback from resurrecting cleared credentials. */
    private sessionPersistenceSuspended = false;

    constructor(options: MCPDeviceOptions = {}) {
        this.baseServerUrl = process.env.MCP_SERVER_URL || 'https://mcp.desktopcommander.app';
        this.remoteChannel = new RemoteChannel();
        this.deviceId = undefined;
        this.isShuttingDown = false;
        this.configPath = getRemoteDeviceConfigPath();
        // Default ON. Off meant a full re-authorization on every start, and each
        // one mints a fresh GoTrue session that nothing ever revokes; the orphaned
        // refresh-token families get replayed, trip GoTrue's reuse detection, and
        // take the whole family down including the token a healthy connector holds.
        this.persistSession = options.persistSession ?? true;

        // Initialize desktop integration
        this.desktop = new DesktopCommanderIntegration();

        // Supabase rotates refresh tokens. Persist every accepted rotation as it
        // happens; otherwise a later supervisor restart replays an obsolete token
        // and falls back to the interactive browser/device-confirmation screen.
        this.remoteChannel.onSessionChanged((session) =>
            session ? this.persistSessionSnapshot(session) : this.clearPersistedConfig()
        );

        // Graceful shutdown handlers (only set once)
        this.setupShutdownHandlers();
    }

    private setupShutdownHandlers() {
        const handleShutdown = async (signal: string) => {
            if (this.isShuttingDown) {
                console.log(`\n${signal} received, but already shutting down...`);
                // Force exit if we get multiple signals
                process.exit(1);
                return;
            }

            console.log(`\n${signal} received, initiating graceful shutdown...`);

            // Force exit after 5 seconds if graceful shutdown hangs
            const forceExit = setTimeout(() => {
                console.error('\n⚠️ Graceful shutdown timed out, forcing exit...');
                process.exit(1);
            }, 5000);

            try {
                await this.shutdown();
                clearTimeout(forceExit);
                process.exit(0);
            } catch (error) {
                console.error('Error during shutdown:', error);
                await captureRemote('remote_device_shutdown_handler_error', { error });
                process.exit(1);
            }
        };

        // Remove any existing SIGINT/SIGTERM listeners to prevent default behavior
        // process.removeAllListeners('SIGINT');
        // process.removeAllListeners('SIGTERM');

        // Add our custom handlers
        process.on('SIGINT', () => {
            handleShutdown('SIGINT').catch((error) => {
                console.error('Fatal error during shutdown:', error);
                captureRemote('remote_device_shutdown_handler_error', { error, signal: 'SIGINT' }).catch(() => { });
                process.exit(1);
            });
        });

        process.on('SIGTERM', () => {
            handleShutdown('SIGTERM').catch((error) => {
                console.error('Fatal error during shutdown:', error);
                captureRemote('remote_device_shutdown_handler_error', { error, signal: 'SIGTERM' }).catch(() => { });
                process.exit(1);
            });
        });
    }

    async start() {
        try {
            console.log('🚀 Starting MCP Device...');
            if (process.env.DEBUG_MODE === 'true') {
                console.log(`  - 🐞 DEBUG_MODE`);
            }


            // Initialize desktop integration
            await this.desktop.initialize();
            this.desktop.onDisconnect((reason) => void this.handleLocalMcpLoss(reason));
            this.localMcpStableSince = Date.now();

            console.log(`⏳ Connecting to Remote MCP ${this.baseServerUrl}`);
            const { supabaseUrl, anonKey } = await this.fetchSupabaseConfig();
            console.log(`   - 🔌 Connected to Remote MCP`);

            // Initialize Remote Channel
            this.remoteChannel.initialize(supabaseUrl, anonKey);

            // Load persisted configuration (deviceId, session)
            let session = await this.loadPersistedConfig();

            // 2. Set Session or Authenticate
            if (session) {
                const { error } = await this.remoteChannel.setSession(session);

                if (error) {
                    console.log('   - ⚠️ Persisted session invalid:', error.message);
                    // Do not leave a rejected/rotated refresh token on disk while
                    // interactive re-authorization is in progress. A supervisor
                    // restart during that window must not replay it again.
                    await this.clearPersistedConfig();
                    session = null;
                } else {
                    console.log('   - ✅ Session restored');
                    console.log('   - ℹ️  To log out locally: npx @wonderwhy-er/desktop-commander@latest remote --logout');

                    // Revoking a device removes its server-side mcp_devices row, but the
                    // local config can still hold a valid user session + the now-deleted
                    // device ID. Do not silently recreate the revoked device with that
                    // old session: revocation must require a fresh browser authorization.
                    if (this.deviceId) {
                        const persistedDevice = await this.findPersistedDeviceWithRetry(this.deviceId);
                        if (!persistedDevice) {
                            console.log(`   - ⚠️ Persisted device ${this.deviceId} was revoked or removed`);
                            await this.clearPersistedConfig();
                            this.deviceId = undefined;
                            session = null;
                        }
                    }
                }
            }

            if (!session) {
                console.log('\n🔐 Authenticating with Remote MCP server...');
                const authenticator = new DeviceAuthenticator(this.baseServerUrl);
                session = await authenticator.authenticate(this.deviceId);
                if (session.device_id) {
                    if (!this.deviceId) {
                        await captureRemote('remote_device_auth_success', {
                            "device": "assigned"
                        });
                        console.log(`   - ✅ Device ID assigned: ${session.device_id}`);
                    } else if (this.deviceId !== session.device_id) {
                        await captureRemote('remote_device_auth_success', {
                            "device": "changed"
                        });
                        console.log(`   - ⚠️ Device ID changed: ${this.deviceId} → ${session.device_id}`);
                    } else {
                        await captureRemote('remote_device_auth_success', {
                            "device": "authenticated"
                        });
                        console.log(`   - ✅ Device ID authenticated: ${session.device_id}`);
                    }
                    this.deviceId = session.device_id;
                }
                // This is a newly approved session; allow its token family to
                // replace any credentials that were deliberately cleared above.
                this.sessionPersistenceSuspended = false;
                // Set session in Remote Channel
                const { error } = await this.remoteChannel.setSession(session);
                if (error) throw error;
            }


            // Force save the current session immediately to ensure it's persisted
            await this.savePersistedConfig();

            const deviceName = os.hostname();

            // Register as device
            await this.remoteChannel.registerDevice(
                await this.desktop.listClientTools(),
                this.deviceId,
                deviceName,
                (payload: any) => this.handleNewToolCall(payload)
            );

            console.log('✅ Device ready:');
            console.log(`   - User:         ${this.remoteChannel.user!.email}`);
            console.log(`   - Device ID:    ${this.deviceId}`);
            console.log(`   - Device Name:  ${deviceName}`);

            // Keep process alive
            this.remoteChannel.startHeartbeat(this.deviceId!);

        } catch (error: any) {
            console.error(' - ❌ Device startup failed:', error.message);
            if (error.stack && process.env.DEBUG_MODE === 'true') {
                console.error('Stack trace:', error.stack);
            }
            await captureRemote('remote_device_startup_failed', { error });
            await this.shutdown();
            process.exit(1);
        }
    }



    private async findPersistedDeviceWithRetry(deviceId: string) {
        let lastError: any;
        for (let attempt = 1; attempt <= PERSISTED_DEVICE_LOOKUP_ATTEMPTS; attempt++) {
            try {
                return await this.remoteChannel.findDevice(deviceId);
            } catch (error: any) {
                lastError = error;
                if (attempt === PERSISTED_DEVICE_LOOKUP_ATTEMPTS) break;
                console.warn(`   - ⚠️ Device lookup failed (${attempt}/${PERSISTED_DEVICE_LOOKUP_ATTEMPTS}); retrying...`);
                await new Promise((resolve) => setTimeout(resolve, PERSISTED_DEVICE_LOOKUP_RETRY_MS * attempt));
            }
        }
        throw lastError;
    }

    async loadPersistedConfig() {
        try {
            console.debug('[DEBUG] Loading persisted config from:', this.configPath);
            const data = await fs.readFile(this.configPath, 'utf8');
            const config = JSON.parse(data);

            this.deviceId = config?.deviceId;
            console.debug('[DEBUG] Loaded device ID:', this.deviceId);

            if (config.session && this.persistSession) {
                console.log('💾 Found persisted session for device ' + this.deviceId);
                console.debug('[DEBUG] Session found in config, returning session');
                return config.session;
            }

            // A previously saved session must not be reused on an opted-out run:
            // it would skip the re-authorization the flag promises, and the save
            // at the end of start() then discards a possibly-rotated refresh
            // token — orphaning one more live server-side session.
            if (config.session) {
                console.debug('[DEBUG] Ignoring persisted session (--no-persist-session)');
            } else {
                console.debug('[DEBUG] No session in config');
            }
            return null;
        } catch (error: any) {

            if (error.code !== 'ENOENT') {
                console.warn('⚠️ Failed to load config:', error.message);
                await captureRemote('remote_device_config_load_error', { error });
            } else {
                console.debug('[DEBUG] Config file does not exist (ENOENT)');
            }
            return null;
        } finally {
            // No need to ensure device ID here
        }
    }

    private async persistSessionSnapshot(session: PersistedSession | null): Promise<void> {
        if (this.sessionPersistenceSuspended) return;

        const generation = this.configWriteGeneration;
        const config: PersistedDeviceConfig = {
            deviceId: this.deviceId,
            session: (session && this.persistSession) ? {
                access_token: session.access_token,
                refresh_token: session.refresh_token ?? null,
            } : null,
        };

        const operation = this.configWriteChain.then(async () => {
            if (generation !== this.configWriteGeneration || this.sessionPersistenceSuspended) return;
            await writeRemoteDeviceConfigAtomically(this.configPath, config);
            console.debug('[DEBUG] Persisted current remote session atomically');
        });
        // A failed write must not poison every later refresh. The individual
        // caller still observes and reports its own failure below.
        this.configWriteChain = operation.catch(() => { });

        try {
            await operation;
        } catch (error: any) {
            console.error(' - ❌ Failed to persist refreshed remote session:', error.message);
            await captureRemote('remote_device_config_save_error', { error });
        }
    }

    async clearPersistedConfig() {
        // Invalidate all queued token writes before the deletion enters the same
        // serial chain. An in-flight write finishes first, then deletion wins.
        this.sessionPersistenceSuspended = true;
        this.configWriteGeneration++;
        const operation = this.configWriteChain.then(() => fs.rm(this.configPath, { force: true }));
        this.configWriteChain = operation.catch(() => { });

        try {
            await operation;
            console.debug('[DEBUG] Cleared stale persisted config:', this.configPath);
        } catch (error: any) {
            console.warn('⚠️ Failed to clear stale config:', error.message);
            await captureRemote('remote_device_config_clear_error', { error });
        }
    }

    async savePersistedConfig() {
        try {
            console.debug('[DEBUG] Saving persisted config, persistSession:', this.persistSession);
            const currentSessionStore = await this.remoteChannel.getSession();
            const session = currentSessionStore.data.session;
            await this.persistSessionSnapshot(session ? {
                access_token: session.access_token,
                refresh_token: session.refresh_token ?? null,
            } : null);
        } catch (error: any) {
            console.error(' - ❌ Failed to read current session for persistence:', error.message);
            await captureRemote('remote_device_config_save_error', { error });
        }
    }

    async fetchSupabaseConfig() {
        // No auth header needed for this public endpoint
        console.debug('[DEBUG] Fetching Supabase config from:', `${this.baseServerUrl}/api/mcp-info`);
        const response = await fetch(`${this.baseServerUrl}/api/mcp-info`);

        if (!response.ok) {
            console.debug('[DEBUG] Supabase config fetch failed, status:', response.status, response.statusText);
            throw new Error(`Failed to fetch Supabase config: ${response.statusText}`);
        }

        const config = await response.json();
        console.debug('[DEBUG] Supabase config received, URL:', config.supabaseUrl?.substring(0, 30) + '...');
        return {
            supabaseUrl: config.supabaseUrl,
            anonKey: config.supabasePublishableKey
        };
    }

    // Methods moved to RemoteChannel

    /**
     * The local Desktop Commander child died. A healthy remote channel says
     * nothing about the local half being alive, so without this the device kept
     * reporting itself online and every routed tool call came back "Not
     * connected" until someone restarted the process by hand.
     */
    private async handleLocalMcpLoss(reason: string): Promise<void> {
        if (this.isShuttingDown) return;

        // Concurrent close/error signals and a tool-call-side reconnect share a
        // single recovery loop. Without this, duplicate events spawn competing
        // children and contradictory online/offline writes.
        if (this.localRecoveryPromise) {
            await this.localRecoveryPromise;
            return;
        }

        // Mark execution unavailable immediately. The method flips its in-memory
        // gate synchronously before any network await, so no new Presence or
        // heartbeat can re-advertise a dead child.
        void this.remoteChannel.setExecutionReady(false)
            .catch((error: any) =>
                console.error(`Failed to publish local MCP loss: ${error?.message}`));

        this.localRecoveryPromise = this.recoverLocalMcp(reason).finally(() => {
            this.localRecoveryPromise = null;
        });
        await this.localRecoveryPromise;
    }

    private async recoverLocalMcp(reason: string): Promise<void> {
        const positiveEnv = (name: string, fallback: number): number => {
            const parsed = Number(process.env[name]);
            return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
        };
        const baseMs = positiveEnv('DC_LOCAL_RESTART_BACKOFF_BASE_MS', 1000);
        const maxMs = positiveEnv('DC_LOCAL_RESTART_BACKOFF_MAX_MS', 30000);
        const stableMs = positiveEnv('DC_LOCAL_RESTART_STABLE_UPTIME_MS', 60000);

        if (!this.localMcpStableSince || Date.now() - this.localMcpStableSince >= stableMs) {
            this.localRestartAttempt = 0;
        }

        while (!this.isShuttingDown) {
            const exponent = Math.min(this.localRestartAttempt, 16);
            const delayMs = Math.min(baseMs * 2 ** exponent, maxMs);
            const jitterMs = Math.floor(Math.random() * Math.max(1, delayMs * 0.15));
            const attempt = ++this.localRestartAttempt;

            console.log(
                `♻️  Restarting local Desktop Commander MCP in ${delayMs + jitterMs}ms ` +
                `(attempt ${attempt})`
            );
            await new Promise(resolve => setTimeout(resolve, delayMs + jitterMs));
            if (this.isShuttingDown) return;

            try {
                // If an in-flight tool already performed the safe on-demand
                // reconnect, ensureReady() is a cheap no-op here.
                await this.desktop.ensureReady();
                this.localMcpStableSince = Date.now();
                await this.remoteChannel.setExecutionReady(true);
                console.log(
                    `✅ Local Desktop Commander MCP recovered on attempt ${attempt}; device is executable`
                );
                void captureRemote('remote_device_local_mcp_recovered', { reason, attempt })
                    .catch(() => { /* recovery must not depend on telemetry */ });
                return;
            } catch (error: any) {
                console.error(`❌ Local MCP restart attempt ${attempt} failed: ${error?.message}`);
                void captureRemote('remote_device_local_mcp_restart_failed', {
                    error,
                    reason,
                    attempt,
                    nextDelayMaxMs: Math.min(delayMs * 2, maxMs),
                }).catch(() => { /* recovery must not depend on telemetry */ });
            }
        }
    }

    /** Record a handled call id, evicting the oldest once the cap is reached. */
    private rememberCallId(callId: string) {
        this.seenCallIds.add(callId);
        if (this.seenCallIds.size > SEEN_CALL_IDS_MAX) {
            // Sets iterate in insertion order — drop the oldest entry.
            const oldest = this.seenCallIds.values().next().value;
            if (oldest !== undefined) this.seenCallIds.delete(oldest);
        }
    }

    async handleNewToolCall(payload: any) {
        const toolCall = payload.new;
        // Expect toolCall to include a device_id field used to route calls to this device instance.
        const { id: call_id, tool_name, tool_args, device_id, metadata = {} } = toolCall;

        console.debug('[DEBUG] Tool call received, device_id:', device_id, 'this.deviceId:', this.deviceId);

        // Only process jobs for this device
        if (device_id && device_id !== this.deviceId) {
            console.debug('[DEBUG] Ignoring tool call for different device');
            return;
        }

        console.log(`🔧 Received tool call ${call_id}: ${tool_name} ${JSON.stringify(tool_args)} metadata: ${JSON.stringify(metadata)}`);

        // LOCAL claim first — this is the authoritative guard against executing
        // a call twice. During the transition both transports deliver every call
        // to THIS SAME PROCESS, so an in-memory check is sufficient and, unlike
        // the DB claim below, cannot fail open: a transient REST error made
        // markCallExecuting return true for both deliveries, which could run a
        // side-effecting command twice (found in review, 2026-07-24).
        if (this.seenCallIds.has(call_id)) {
            console.debug('[DEBUG] Duplicate delivery for call already handled here, skipping:', call_id);
            return;
        }
        this.rememberCallId(call_id);

        try {
            // DB claim second — keeps the row state machine honest, gives
            // cross-restart/cross-process protection, and is observable. It may
            // fail open (returns true on a transient write error); the local
            // guard above is what makes execution exactly-once.
            const claimed = await this.remoteChannel.markCallExecuting(call_id);
            if (!claimed) {
                // markCallExecuting already logged the duplicate-delivery skip.
                return;
            }

            let result;

            // Handle 'ping' tool specially
            if (tool_name === 'ping') {
                result = {
                    content: [{
                        type: 'text',
                        text: `pong ${new Date().toISOString()}`
                    }]
                };
            } else if (tool_name === 'shutdown') {
                result = {
                    content: [{
                        type: 'text',
                        text: `Shutdown initialized at ${new Date().toISOString()}`
                    }]
                };

                // Trigger shutdown after sending response
                setTimeout(async () => {
                    console.log('🛑 Remote shutdown requested. Exiting...');
                    await this.shutdown();
                    process.exit(0);
                }, 1000);
            } else {
                // Execute other tools using desktop integration
                result = await this.desktop.callClientTool(tool_name, tool_args, metadata);
            }

            console.log(`✅ Tool call ${tool_name} completed:\r\n ${JSON.stringify(result)}`);

            // Update database with result, THEN ring the doorbell — the server
            // fetches the row by id on the doorbell, so the write must land first.
            await this.remoteChannel.updateCallResult(call_id, 'completed', result);
            await this.remoteChannel.notifyResult(call_id);

        } catch (error: any) {
            console.error(`❌ Tool call ${tool_name} failed:`, error.message);
            // The failure path must not fail: this method's promise is discarded
            // at every call site, so a throw here becomes an unhandled rejection
            // and takes the device process down.
            try {
                await captureRemote('remote_device_tool_call_failed', { error, tool_name });
                await this.remoteChannel.updateCallResult(call_id, 'failed', null, error.message);
                await this.remoteChannel.notifyResult(call_id);
            } catch (reportError: any) {
                console.error(`❌ Could not report failure for ${call_id}:`, reportError?.message);
            }
        }
    }

    async shutdown() {
        if (this.isShuttingDown) {
            console.debug('[DEBUG] Shutdown already in progress, returning');
            return;
        }

        this.isShuttingDown = true;
        console.log('\n🛑 Shutting down device...');
        console.debug('[DEBUG] Shutdown initiated for device:', this.deviceId);

        try {
            // Stop heartbeat first to prevent new operations
            console.log('  → Stopping heartbeat...');
            console.debug('[DEBUG] Calling stopHeartbeat()');
            this.remoteChannel.stopHeartbeat();
            console.log('  ✓ Heartbeat stopped');

            // Unsubscribe from channel
            console.log('  → Unsubscribing from channel...');
            console.debug('[DEBUG] Calling channel.unsubscribe()');
            await this.remoteChannel.unsubscribe();

            // Mark device offline
            console.log('  → Marking device offline...');
            console.debug('[DEBUG] Calling setOffline() with deviceId:', this.deviceId);
            await this.remoteChannel.setOffline(this.deviceId);

            // Shutdown desktop integration
            console.log('  → Shutting down desktop integration...');
            console.debug('[DEBUG] Calling desktop.shutdown()');
            await this.desktop.shutdown();
            console.log('  ✓ Desktop integration shut down');

            console.log('✓ Device shutdown complete');
            console.debug('[DEBUG] Shutdown sequence completed successfully');
        } catch (error: any) {
            console.error('Shutdown error:', error.message);
            console.debug('[DEBUG] Shutdown error stack:', error.stack);
            await captureRemote('remote_device_shutdown_error', { error });
        }
    }
}

// Start device if called directly or as a bin command
// When installed globally, npm creates a wrapper, so we need to check multiple conditions
const isMainModule = process.argv[1] && (
    // Direct execution: node device.js
    import.meta.url === `file://${process.argv[1]}` ||
    fileURLToPath(import.meta.url) === process.argv[1] ||
    // Global bin execution: desktop-commander-device (npm creates a wrapper)
    process.argv[1].endsWith('desktop-commander-device') ||
    process.argv[1].endsWith('desktop-commander-device.js')
);

if (isMainModule) {
    // Parse command-line arguments
    const args = process.argv.slice(2);
    const options = {
        // --persist-session is kept as an accepted no-op so existing invocations
        // and docs keep working; --no-persist-session opts back out.
        persistSession: !args.includes('--no-persist-session')
    };

    if (!options.persistSession) {
        console.log('🔓 Session persistence disabled — re-authorization required on every start');
    }

    const device = new MCPDevice(options);
    device.start();
}
