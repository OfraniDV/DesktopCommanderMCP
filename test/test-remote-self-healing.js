/**
 * Regression tests for remote-device local MCP self-healing.
 */
import assert from 'node:assert/strict';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
process.env.DC_LOCAL_RESTART_BACKOFF_BASE_MS = '5';
process.env.DC_LOCAL_RESTART_BACKOFF_MAX_MS = '10';
process.env.DC_LOCAL_RESTART_STABLE_UPTIME_MS = '1000';

const { DesktopCommanderIntegration } = await import(
  '../dist/remote-device/desktop-commander-integration.js'
);
const { RemoteChannel } = await import('../dist/remote-device/remote-channel.js');
const { MCPDevice } = await import('../dist/remote-device/device.js');

async function testRetriesOnlyDefinitelyUndispatchedCall() {
  const integration = new DesktopCommanderIntegration();
  const transports = [{ generation: 1 }, { generation: 2 }];
  const calls = [];
  let ensureCalls = 0;

  const clients = [
    {
      callTool: async () => {
        calls.push('first');
        throw new Error('Not connected');
      },
    },
    {
      callTool: async ({ name }) => {
        calls.push(`second:${name}`);
        return { content: [{ type: 'text', text: 'recovered' }] };
      },
    },
  ];

  integration.onDisconnect(() => {});
  integration.ensureReady = async () => {
    const index = Math.min(ensureCalls, 1);
    ensureCalls += 1;
    integration.mcpClient = clients[index];
    integration.mcpTransport = transports[index];
    integration.isReady = true;
  };

  const result = await integration.callClientTool('get_config', {});
  assert.equal(result.content[0].text, 'recovered');
  assert.equal(ensureCalls, 2, 'must reconnect exactly once');
  assert.deepEqual(calls, ['first', 'second:get_config']);
}

async function testDoesNotRetryAmbiguousFailure() {
  const integration = new DesktopCommanderIntegration();
  let ensureCalls = 0;
  let toolCalls = 0;

  integration.ensureReady = async () => {
    ensureCalls += 1;
    integration.mcpTransport = { generation: 1 };
    integration.mcpClient = {
      callTool: async () => {
        toolCalls += 1;
        throw new Error('Connection closed');
      },
    };
    integration.isReady = true;
  };

  await assert.rejects(
    integration.callClientTool('start_process', { command: 'echo test' }),
    /Connection closed/
  );
  assert.equal(ensureCalls, 1, 'ambiguous failures must not reconnect and replay');
  assert.equal(toolCalls, 1, 'ambiguous operations must execute at most once');
}

async function testIgnoresStaleTransportClose() {
  const integration = new DesktopCommanderIntegration();
  const oldTransport = { generation: 1 };
  const freshTransport = { generation: 2 };
  const freshClient = { callTool: async () => ({}) };
  let disconnects = 0;

  integration.mcpTransport = freshTransport;
  integration.mcpClient = freshClient;
  integration.isReady = true;
  integration.onDisconnect(() => { disconnects += 1; });
  integration.handleLocalDisconnect('late close', oldTransport);

  assert.equal(integration.ready, true);
  assert.equal(integration.mcpTransport, freshTransport);
  assert.equal(integration.mcpClient, freshClient);
  assert.equal(disconnects, 0);
}

async function testExecutionHealthGatesPresenceAndHeartbeat() {
  const channel = new RemoteChannel();
  const reachability = [];
  const capabilities = [];
  let untracks = 0;
  let tracks = 0;

  channel.channel = {
    state: 'joined',
    untrack: async () => {
      untracks += 1;
      return 'ok';
    },
    track: async () => {
      tracks += 1;
      return 'ok';
    },
  };
  channel.deviceId = 'test-device';
  channel.deviceName = 'test-host';
  channel.setTransportCapable = async (ready) => {
    capabilities.push(ready);
  };
  channel.syncReachabilityStatus = () => {
    reachability.push(channel.isReachable());
  };

  await channel.setExecutionReady(false);
  await channel.setExecutionReady(false);
  await channel.setExecutionReady(true);

  assert.deepEqual(reachability, [false, true]);
  assert.deepEqual(capabilities, [false, true]);
  assert.equal(untracks, 1);
  assert.equal(tracks, 1);
}

async function testRecoveryRetriesAndIsSerialized() {
  const device = new MCPDevice();
  const readiness = [];
  let attempts = 0;

  device.remoteChannel = {
    setExecutionReady: async (ready) => {
      readiness.push(ready);
    },
  };
  device.desktop = {
    ensureReady: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('simulated transient failure');
    },
  };

  device.localMcpStableSince = Date.now();

  await Promise.all([
    device.handleLocalMcpLoss('close signal'),
    device.handleLocalMcpLoss('duplicate error signal'),
  ]);

  assert.equal(attempts, 3, 'transient startup failures must be retried');
  assert.deepEqual(readiness, [false, true], 'availability transitions must be unique');
  assert.equal(device.localRecoveryPromise, null);
}

const cases = [
  ['safe undispatched retry', testRetriesOnlyDefinitelyUndispatchedCall],
  ['no replay after ambiguous failure', testDoesNotRetryAmbiguousFailure],
  ['stale transport close ignored', testIgnoresStaleTransportClose],
  ['execution health gates reachability', testExecutionHealthGatesPresenceAndHeartbeat],
  ['serialized retrying recovery', testRecoveryRetriesAndIsSerialized],
];

let failed = 0;
console.log('=== remote self-healing regression suite ===');
for (const [name, run] of cases) {
  try {
    await run();
    console.log(`✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`✗ ${name}: ${error?.stack ?? error}`);
  }
}

console.log(`\n${cases.length - failed}/${cases.length} passed`);
if (failed > 0) process.exitCode = 1;
