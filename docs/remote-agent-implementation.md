# Remote agent implementation map

Companion to [docs/remote-agent.md](remote-agent.md) for OMP developers.
Audience: maintainers of the paged guest, durable attachment, and QUIC
sidecar.

## Rendering and navigation

`packages/tui/src/render/source-map.ts` carries structural anchors through
rendering: each rendered block records its source text, byte offsets, and
block identity produced by the actual parser, not by matching rendered words
against the source. `packages/tui/src/components/markdown.ts` renders
through one mapped path (`renderMapped`) shared with the interactive TUI, so
normalization, streaming-cache behavior, tabs, and fences behave identically.

`packages/tui/src/components/markdown-window.ts` renders a bounded window of
Markdown with continuation context: syntax state (fence, table, list, inline)
is computed from a bounded look-back so a block beginning before the cached
range renders correctly without exhausting the page budget.

The paged guest (`packages/coding-agent/src/remote/`) joins contiguous cached
fragments in `viewport.ts`, storing the last fragment's suffix, and keeps the
cache in `page-cache.ts`. Render results are memoized per source revision.

Tool calls and results merge into single cards; arguments omitted from the
metadata budget are recovered from the paged source text. Fragment metadata
(`prefix`, `suffix`, `tool`) is validated at the receiving trust boundary.

## Durable attachment and recovery

`packages/coding-agent/src/collab/host-profile.ts` persists a host binding —
profile name, session file, relay URL, timestamps — under the OMP config
root, `0600`, before the host accepts clients. `resolveHostBinding` refuses
silent rebinds. `packages/coding-agent/src/commands/host.ts` registers the
persistent `omp host` command; it loads the bound session via
`SessionManager.open` + `createAgentSession` + `initializeExtensions` and
starts a `CollabHost` against the configured relay.

Host-side prompt deduplication compares the SHA-256 digest of the original
guest submission (`remotePromptDigest` in `packages/wire/src/remote.ts`), so
extension-rewritten persisted content does not break retries.

Paged notifications carry a session-scoped `epoch` and monotonic `seq`
(`packages/wire/src/remote.ts`, `RemoteHistoryChanged`). The host bumps the
epoch on compaction, branch, session switch, and room recreation; the guest
(`packages/coding-agent/src/remote/guest.ts`) detects gaps and resyncs with a
bounded page fetch. `RemoteCaptureControl` carries the guest's last seen
epoch; the host rejects stale operations.

The guest saves its last deployment endpoint in `saved-state.ts`
(`packages/coding-agent/src/remote/`), independent of invitation URLs.

## Authenticated QUIC sidecar

`crates/omp-remote-quic` is a workspace member with a lib target and a thin
CLI binary. Modules:

| Module | Role |
|---|---|
| `identity.rs` | Self-signed certificate + key generation, SHA-256 fingerprints |
| `enrollment.rs` | Explicit client-fingerprint allowlist with `read`/`write` roles and revocation |
| `transport.rs` | Quinn 0.11 config: server pin verification, client-cert allowlist, keep-alives |
| `framing.rs` | u32 big-endian length-prefixed frames, 4 MiB cap, abort on oversize |
| `relay.rs` | Room broker speaking the existing relay contract (peerId envelopes, `peer-joined`/`peer-left`/`room-closed` controls); roles are assigned server-side by the local WS surface, never forgeable |
| `main.rs` | CLI: `identity`, `fingerprint`, `enroll`, `revoke`, `serve`, `connect` |

The sidecar bridges the existing relay WebSocket contract over QUIC streams,
so OMP processes speak unchanged WebSocket while the network path is QUIC.

Verification: `crates/omp-remote-quic/tests/loopback.rs` runs the security
matrix in-process (enrolled relay, wrong pin, unknown client, revoked client,
read-tier enrollment, oversized-frame abort, room-close notification). Run
with `bun run test:rs`.

## Verification and operating limits

All collaboration, paged-history, paged-guest, and host-profile tests live in
`packages/coding-agent/test/collab/`. The QUIC matrix is in the crate's
`tests/`. Limits are documented in `docs/remote-agent.md` (sidecar wiring,
packaging, metrics export, Mac helper validation, capture continuation, and
the train trial remain outstanding).
