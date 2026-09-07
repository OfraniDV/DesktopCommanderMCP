# Remote stability release: 0.2.49-odulami.1

Date: 2026-09-07
Distribution: OfraniDV GitHub fork build (not an upstream npm release)
Base: upstream `wonderwhy-er/DesktopCommanderMCP` main at `2433701`

## Incident reproduced

The remote connector process and Supabase channel remained healthy, so `ping`
continued to work, while delegated MCP tools failed with the SDK error
`Not connected`. The local stdio Desktop Commander child had disappeared, but
the device could still be advertised as online. Manual service restart was then
required to restore tool execution.

The SDK emits the exact `Not connected` error before a JSON-RPC request is sent
to a transport. That case is safe to reconnect and retry once. Errors such as
`Connection closed`, request timeout, or an arbitrary tool failure are not safe
to replay because the operation may already have started.

## Correctness and availability invariants

1. A device is executable only when both the remote channel and local MCP child
   are healthy.
2. Presence, heartbeat, and online status must not advertise a dead local child.
3. A routed operation is retried only when the SDK proves it was not dispatched.
4. Ambiguous failures are returned to the caller and never replayed.
5. Duplicate close/error events must share one recovery loop.
6. An obsolete child transport must never tear down a newer healthy transport.
7. Telemetry failure must never stop recovery.

## Implementation

- Attach stdio close/error supervision before `Client.connect()` so the SDK keeps
  its own close handler and in-flight requests fail promptly.
- Track the transport generation and ignore late close callbacks from replaced
  children.
- Reconnect and retry exactly once for the SDK's exact pre-dispatch
  `Not connected` error.
- Add a serialized local-child recovery loop with exponential backoff and jitter.
- Withdraw Presence and broadcast capability while the local child is unavailable.
- Gate online status and heartbeat on both channel health and execution health.
- Restore Presence only after the replacement child is actually ready.

## Windows atomic configuration writes

A concurrent-read stress test exposed transient Windows `EPERM` failures while
atomically renaming a completed temporary config file over `config.json`.
The writer now retries only `EPERM`, `EACCES`, and `EBUSY` on Windows, using the
same completed temporary file. It never falls back to an in-place write, so
readers still see either the old complete JSON or the new complete JSON.

## Recovery settings

Defaults are intentionally bounded and can be overridden for diagnostics:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `DC_LOCAL_RESTART_BACKOFF_BASE_MS` | `1000` | First local-child restart delay |
| `DC_LOCAL_RESTART_BACKOFF_MAX_MS` | `30000` | Maximum delay between attempts |
| `DC_LOCAL_RESTART_STABLE_UPTIME_MS` | `60000` | Healthy interval that resets the ladder |

Each delay includes up to 15 percent jitter. Recovery continues until success or
intentional process shutdown; it does not enter a tight respawn loop.

## Regression coverage

`test/test-remote-self-healing.js` verifies:

- safe one-time retry after a definitely undispatched `Not connected` failure;
- no replay after ambiguous `Connection closed` failure;
- stale transport close callbacks cannot invalidate a replacement connection;
- execution health gates Presence, capability, heartbeat, and online status;
- transient startup failures are retried by one serialized recovery loop.

The existing atomic-write stress test verifies that concurrent readers never see
partial JSON while the Windows retry path is active.

## Release and deployment policy

This fork build is distributed as a GitHub release tarball and is deliberately
marked `private` in `package.json`. It is not published to npm and does not claim
to replace the upstream `@wonderwhy-er/desktop-commander` release.

Production installation uses the release tarball by absolute path. Before
installation, preserve the official `0.2.48` npm tarball and the active systemd
unit. Restart only `desktop-commander-remote.service`; never use a global PM2 or
host restart for this deployment.
