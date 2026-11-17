# Paged remote guest, durable attachment, and the QUIC sidecar

OMP supports a remote coding-agent client for poor connectivity: the host runs
the agent and tools on Linux, and a MacBook renders a bounded local replica.
The guest keeps its usable cache while offline and reattaches without
downloading the full transcript. All stages are experimental.

## Start a host

Run an ordinary OMP session on Linux, then enter `/collab`. Keep that process
running in a persistent terminal session. For a session that survives
reconnects and host restarts, use the persistent host command instead:

```sh
omp host --profile=train --session=<file|id>
```

The host binds to one explicit session and records the binding before it
accepts clients. It refuses to silently switch sessions: re-running the
command with the same profile reuses the stored binding, and a different
`--session` is a hard error. Use a different profile or delete the profile to
rebind. Bindings live in the OMP config root under `remote/hosts`; credentials
stay in the invitation link and are never persisted.

## Start a paged guest

On the client, using this version of OMP:

```sh
omp join --paged "<collab-link>"
```

The host must support paged history. Older hosts are rejected rather than
silently downloading the full transcript. Ordinary `omp join` remains
unchanged.

## Navigate cached history

Use the mouse wheel or Page Up/Page Down to navigate. Ctrl+End returns to live
output. The guest keeps at most three 64 KiB pages. Indicators distinguish
missing history, a load in progress, an offline boundary, and the actual
transcript end.

Rendering uses structural source anchors: every rendered block carries its
source text, byte offsets, and block identity, so the viewport stays anchored
through page insertion, eviction, and pane resize. Markdown continuation is
bounded: a fenced block, table, or list that begins before the cached range
render with explicit syntax context rather than unbounded look-back. Tool
calls and results render as merged cards with the full paged argument and
result text; oversized arguments are recovered from paged text instead of the
truncated metadata. Images render as bounded placeholders; the Agent Hub and
remote subagent controls work for the paged guest with bounded subagent
history.

## Offline behavior and reattachment

Cached content remains readable when disconnected. Drafts, cached pages, and
pending prompt IDs are saved privately under `~/.omp/remote/guests`. Offline
Enter retains the draft; it does not schedule a new prompt. Previously
submitted online prompts can be retried with their original IDs after
reattachment to the same session. Keep prompts below 64 KiB; at most 16
unacknowledged submissions are kept.

Host-side deduplication compares the SHA-256 of the original submission, so
extension-rewritten content does not cause false rejections or duplicate
submissions.

Streaming updates reuse overlapping cached text when its hash matches. A
missing or mismatched cache falls back to one bounded page. The guest never
needs the complete transcript to reconnect or reflow cached text after a pane
resize.

The guest remembers the deployment endpoint it last connected to, independent
of invitation URLs and loopback ports, so reattachment can prefer the known
endpoint.

## Event epochs and gaps

Paged notifications carry a session-scoped epoch and a monotonic sequence
number. The epoch bumps on compaction, branch, session switch, and room
recreation. A guest that detects a skipped or regressed sequence resyncs from
a bounded page fetch rather than trusting its cache; it never downloads the
full transcript. Capture-control operations carry the guest's last seen
epoch, and the host rejects stale operations instead of applying them twice.

## Record a journey

In the paged guest:

```text
/capture start --location
/capture mark entered tunnel
/capture status
/capture stop
```

`--location` runs a small Core Location helper, compiled locally with Apple's
Command Line Tools. It includes the macOS usage description required by
[Apple's location authorization API](https://developer.apple.com/documentation/corelocation/requesting-authorization-to-use-location-services).
Permission denial or a missing fix does not stop capture. This helper still needs
testing on a Mac; other platforms record diagnostics without Mac location.

The client asks the host to record under the same capture ID. Status distinguishes
an acknowledged operation from a pending server start/stop. Each endpoint writes
independently under `~/.omp/remote/captures`; logs are limited to 256 MiB and four
hours. They contain timing, byte counts, memory/CPU samples, and optional client
location fixes. Byte counts distinguish decoded application data from encrypted
WebSocket payloads; neither measures TCP/TLS overhead or proves delivery.
Conversation bodies and tool output are excluded.
Marks contain the note you explicitly enter. Location helpers stop when capture
ends, including when a recording reaches its size or duration limit.

Stop the capture explicitly before closing the guest. Capture continuation across
a guest process restart is not implemented yet.

## Import phone GPS and generate a report

Record a timestamped GPX track independently on your phone, including while
offline. Copy the matching server recording to your client after the journey:

```sh
omp capture-report client.jsonl --server server.jsonl --gpx journey.gpx --out report.json
```

The report includes request latency percentiles, observed disconnect durations,
byte counts, endpoint memory/CPU summaries, peak client cache size, marks, and GeoJSON
points for both location sources. Nearby phone fixes take precedence, while the
Mac fixes remain available for comparison. Missing fixes are not interpolated;
GPX points without an explicit timezone or valid coordinates are skipped.

Use `--omit-location` to produce a report without coordinates. Output files are
private and are never overwritten. Treat a report containing location as a record
of your journey. The server receives no location fixes.

## QUIC sidecar

The transport is still WebSocket by default. A Rust sidecar,
`omp-remote-quic`, tunnels the existing relay WebSocket contract over QUIC
with authenticated, revocable clients. It is built and verified in-loopback
but is not yet wired into the OMP host/guest commands — see limits below.

The sidecar is a standalone binary in the workspace:

```sh
cargo build -p omp-remote-quic
```

Commands:

```sh
# Generate a self-signed identity (certificate + key) and print its fingerprint.
omp-remote-quic identity --out ./host-id --name host

# Print a certificate's SHA-256 fingerprint.
omp-remote-quic fingerprint --cert ./host-id/cert.pem

# Enroll a client fingerprint (role read or write), or revoke it.
omp-remote-quic enroll --clients ./clients.json --fingerprint <hex> --name mac --role write
omp-remote-quic revoke --clients ./clients.json --fingerprint <hex>

# Host side: local WebSocket surface + QUIC listener.
omp-remote-quic serve --identity ./host-id --clients ./clients.json --bind 0.0.0.0:4433

# Guest side: connect to the pinned host identity.
omp-remote-quic connect --identity ./guest-id --server <host>:4433 --pin <host-fingerprint>
```

Security properties:

- **Mutual pinning.** The guest pins the host certificate fingerprint; the
  host verifies client certificates against an explicit allowlist. Neither
  side trusts a CA chain; a compromised CA cannot introduce a client.
- **Revocation.** Removing an enrolled fingerprint refuses that client from
  the next connection.
- **Roles are server-side.** The host role is assigned by the local WebSocket
  surface on the host machine, never by a parameter a remote side could
  forge. An enrolled guest can never impersonate the host.
- **Bounded frames.** Application frames carry a 4 MiB cap; oversized frames
  abort the connection instead of buffering.

Verification: the loopback matrix covers enrolled-client relay, wrong-pin
refusal, unknown and revoked client refusal, read-tier enrollment,
oversized-frame abort, and host room-close notification.

## Current limits

- The default transport is still WebSocket. The QUIC sidecar is not yet
  connected to the OMP host/guest commands, has no packaging outside a source
  checkout, and no transport-metrics export yet.
- The UDP impairment proxy and Herdr integration are not implemented.
- Cached blocks use structural source anchoring, but rendering parity with
  the interactive TUI is still approximate at the edges; report artifacts in
  narrow panes or across page boundaries.
- Capture continuation across a guest process restart is not implemented.
- The macOS location helper needs build, permission, and location-quality
  testing on a Mac.
- The JSON report exports route points, but does not provide a map viewer.
- A real train recording and validated impairment scenarios remain outstanding.

## Verification

Tests cover byte-bounded Unicode paging, verified deltas, cursor rejection,
cache eviction, streaming-tail retrieval, prompt deduplication, private state
storage, capture limits, GPX import, and report export. A native terminal
integration test checks online submission, offline draft/cache retention,
resize, and guest restart. Host-profile binding, epoch/sequence gap
detection, stale-operation rejection, and endpoint persistence have
contract tests. The collaboration suite checks compatibility with ordinary
hosts and guests.

```sh
bun check
cd packages/coding-agent
bun test test/collab
cd ../..
bun run test:rs
```

Before a train trial, test the Mac helper's build and permission flow, run a local
host/guest capture, disconnect the client while the agent works, and generate a
report with both endpoint files and a short phone track. A real train recording
and the proposed UDP impairment scenarios have not been validated yet.
