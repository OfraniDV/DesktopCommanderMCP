import assert from 'node:assert';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteChannel } from '../dist/remote-device/remote-channel.js';
import { MCPDevice } from '../dist/remote-device/device.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

const flush = () => new Promise(resolve => setTimeout(resolve, 20));

class FakeAuth {
  listeners = [];
  session = {
    access_token: 'access-rotated-during-set',
    refresh_token: 'refresh-rotated-during-set'
  };

  async setSession() { return { data: { session: this.session }, error: null }; }
  async getUser() {
    return { data: { user: { id: 'user-1', email: 'tester@example.com' } }, error: null };
  }
  async getSession() { return { data: { session: this.session }, error: null }; }
  onAuthStateChange(callback) {
    this.listeners.push(callback);
    return { data: { subscription: { unsubscribe() {} } } };
  }
  emit(event, session) {
    for (const callback of this.listeners) callback(event, session);
  }
}

class FakeRealtime {
  setAuthCalls = [];
  setAuth(token) { this.setAuthCalls.push(token); }
}

class FakeClient {
  auth = new FakeAuth();
  realtime = new FakeRealtime();
}

function bareDevice(configPath) {
  const device = Object.create(MCPDevice.prototype);
  device.configPath = configPath;
  device.deviceId = 'device-1';
  device.persistSession = true;
  device.configWriteChain = Promise.resolve();
  device.configWriteGeneration = 0;
  device.sessionPersistenceSuspended = false;
  return device;
}

async function testRemoteChannelPublishesEveryAcceptedRotation() {
  const channel = new RemoteChannel();
  const client = new FakeClient();
  channel.client = client;
  const persisted = [];
  channel.onSessionChanged(async session => persisted.push({ ...session }));

  await channel.setSession({
    access_token: 'access-stale-on-disk',
    refresh_token: 'refresh-stale-on-disk'
  });
  await flush();

  assert.deepStrictEqual(persisted[0], {
    access_token: 'access-rotated-during-set',
    refresh_token: 'refresh-rotated-during-set'
  });

  const secondRotation = {
    access_token: 'access-rotated-later',
    refresh_token: 'refresh-rotated-later'
  };
  client.auth.session = secondRotation;
  client.auth.emit('TOKEN_REFRESHED', secondRotation);
  await flush();

  assert.deepStrictEqual(persisted.at(-1), secondRotation);
  assert.strictEqual(client.realtime.setAuthCalls.at(-1), secondRotation.access_token);
}

async function testNewestRotationSurvivesAProcessRestart() {
  const dir = await mkdtemp(join(tmpdir(), 'dc-session-persist-'));
  const configPath = join(dir, 'device.json');
  try {
    const device = bareDevice(configPath);
    const first = device.persistSessionSnapshot({
      access_token: 'access-first',
      refresh_token: 'refresh-first'
    });
    const second = device.persistSessionSnapshot({
      access_token: 'access-newest',
      refresh_token: 'refresh-newest'
    });
    await Promise.all([first, second]);

    const onDisk = JSON.parse(await readFile(configPath, 'utf8'));
    assert.strictEqual(onDisk.deviceId, 'device-1');
    assert.strictEqual(onDisk.session.access_token, 'access-newest');
    assert.strictEqual(onDisk.session.refresh_token, 'refresh-newest');
    assert.deepStrictEqual(
      (await readdir(dir)).filter(name => name.endsWith('.tmp')),
      [],
      'atomic writer must not leave temporary token files behind'
    );

    const restarted = bareDevice(configPath);
    restarted.deviceId = undefined;
    const restored = await restarted.loadPersistedConfig();
    assert.strictEqual(restarted.deviceId, 'device-1');
    assert.strictEqual(restored.refresh_token, 'refresh-newest');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testRevocationBeatsQueuedAndLateTokenWrites() {
  const dir = await mkdtemp(join(tmpdir(), 'dc-session-clear-'));
  const configPath = join(dir, 'device.json');
  try {
    const device = bareDevice(configPath);
    const queuedWrite = device.persistSessionSnapshot({
      access_token: 'access-before-revoke',
      refresh_token: 'refresh-before-revoke'
    });
    const clear = device.clearPersistedConfig();
    await Promise.all([queuedWrite, clear]);

    await assert.rejects(readFile(configPath, 'utf8'), error => error.code === 'ENOENT');

    await device.persistSessionSnapshot({
      access_token: 'access-late-old-family',
      refresh_token: 'refresh-late-old-family'
    });
    await assert.rejects(readFile(configPath, 'utf8'), error => error.code === 'ENOENT');

    device.sessionPersistenceSuspended = false;
    await device.persistSessionSnapshot({
      access_token: 'access-new-approval',
      refresh_token: 'refresh-new-approval'
    });
    const fresh = JSON.parse(await readFile(configPath, 'utf8'));
    assert.strictEqual(fresh.session.refresh_token, 'refresh-new-approval');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testDefinitiveSessionLossPublishesInvalidation() {
  const channel = new RemoteChannel();
  const observed = [];
  channel.onSessionChanged(async session => observed.push(session));

  await channel.rememberSession({
    access_token: 'access-before-loss',
    refresh_token: 'refresh-before-loss'
  });
  await channel.forgetSession();
  await flush();

  assert.strictEqual(observed.length, 2);
  assert.strictEqual(observed.at(-1), null);
  assert.strictEqual(channel.lastKnownSession, null);
}

const cases = [
  ['publishes every accepted token rotation', testRemoteChannelPublishesEveryAcceptedRotation],
  ['newest rotation survives process restart', testNewestRotationSurvivesAProcessRestart],
  ['revocation beats queued and late writes', testRevocationBeatsQueuedAndLateTokenWrites],
  ['definitive session loss publishes invalidation', testDefinitiveSessionLossPublishesInvalidation]
];
let failures = 0;
for (const [name, run] of cases) {
  try {
    await run();
    console.log(`✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`✗ ${name}: ${error.stack || error.message}`);
  }
}

if (failures) {
  console.error(`${failures}/${cases.length} session-persistence cases failed`);
  process.exit(1);
}
console.log(`All ${cases.length} session-persistence cases passed.`);
