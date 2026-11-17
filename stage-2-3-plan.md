# Remote OMP Agent — Complete Stage 2 Rendering, Stage 3 Durable Attachment & QUIC Sidecar

## Summary

Continue the interrupted implementation in `packages/coding-agent` per the handoff in `plan.md`, in three ordered parts: (A) finish the paged guest renderer (Stage 2), (B) implement durable attachment/recovery (Stage 3, first half), (C) implement the authenticated Quinn 0.11.x Rust sidecar (Stage 3, second half). Stages 4–6 (impairment proxy, Herdr, train trial) are out of scope. Nothing is committed unless the user asks.

## Starting state and ground rules

- Checkout base `6f03614d…` with a substantial uncommitted diff including untracked files. First action in execution: run `git status --short`, inspect the unfinished renderer diff, and work on top of it. Never discard or commit the diff without instruction.
- Bun at `/tmp/omp-bun-1.4.4/package/bin` (add to PATH). Full collaboration tests may need sandbox escalation (Unix sockets/file locks). Rust tests via `bun run test:rs` only.
- Follow repo `AGENTS.md`: no `any`, no `ReturnType<>`, no dynamic/type-only inline imports, no hand-spawned git (use `@oh-my-pi/pi-natives/vcs`), no model-conditional policy in TS, sanitized TUI rendering on every path (`replaceTabs`, `truncateToWidth`, `shortenPath`, `PREVIEW_LIMITS`), prompts stay out of code, tests assert observable contracts and are full-suite safe (no `mock.module()`).
- No deployment, router config, GitHub posting, or PR creation.

## Part A — Complete paged guest rendering (Stage 2)

Goal: a cached source location stays visually stable through resize, page insertion, and eviction; no tool argument/output text disappears because renderer metadata is omitted; Markdown continuation across missing history cannot exhaust a page budget.

1. **Replace heuristic source anchoring with parse-carried spans.** Rewrite TUI `src/render/source-map.ts` so source offsets flow through the actual Markdown lexer/parser into rendered output (spans attached to rendered segments), eliminating `mapSourceRows`' `indexOf` word matching. Explicitly define and implement anchoring for renderer-generated borders (table rules, fence markers). Fix the known viewport bug: joining contiguous fragments must retain the **last** fragment's suffix, not the first's.
2. **Unify rendering paths.** Make `Markdown.renderMapped` reuse the same normalization/cache behavior as normal rendering (including tabs/fences); eliminate the divergent second path or fold it into the main one.
3. **Bound and complete Markdown continuation.** In `markdown-window.ts`: full list/nested-syntax handling; a per-page budget for oversized constructs (e.g. a huge table header is clamped, not allowed to consume the page); fence boundary and arbitrary partial-line coverage across missing history.
4. **Verify history paging binary search.** For the byte-size binary search that adjusts fragments to newlines and adds syntax context: assert monotonicity, guaranteed progress, correct final serialized size, and sane behavior on pathological huge lines/headers.
5. **Merge tool calls and results.** Merge call/result cards into the house `ToolExecutionComponent`/`ToolExecutionUi` presentation; a completed call must not remain "pending". Arguments beyond the 4 KiB metadata budget must render from paged source text, never be silently hidden. Handle huge arguments/details.
6. **Fix the tool-result early return.** Restore image placeholder/content rendering; make `stringifyJson(message.details)` (and any other serialization) safe for unserializable details — no throw escapes history serving.
7. **Validate new wire metadata at trust boundaries.** `prefix`, `suffix`, and `tool` fragment metadata must be validated on receipt (schema check, not type declarations), including protocol-version compatibility with hosts that omit the fields.
8. **Restore paging performance.** Stop repeatedly lexing huge blocks/revisions to fetch a small window (regression ~15 ms → ~600 ms on large-Unicode fixtures). Cache lexed/derived structures; re-lex only invalidated regions. Treat the prior numbers as development observations; re-measure after the fix.
9. **Images.** Render image content with bounded transfer and cache behavior (reuse shared image resize utilities).
10. **Agent Hub and subagents.** Add Agent Hub and remote subagent actions/transcript navigation using existing house components (`AgentHubOverlayComponent`/`AgentHubRemote`, `createAgentHubRuntime`, `SessionObserverRegistry`). Extract/reuse the ordinary guest's display-only remote-agent registry logic. Bound subagent history to the three-page cache; subagent controls respect host access rights (the ordinary guest's 4 MiB fetch / unbounded viewer accumulation does not satisfy this unchanged).

**Tests (contract tests that fail on the named regressions):** displaced anchors after reflow/insertion/eviction; no lost argument/output text with metadata-only budgets; Markdown continuation across cuts (fences, tables, nested lists, partial lines) stays within budget; fragment-join suffix behavior; unserializable details don't break serving; malformed/untrusted fragment metadata rejected; oversized-image handling; live streaming **and** transcript rebuild paths; narrow/wide resize; arbitrary page cuts; offline navigation; large-block render performance spot-check.

**Acceptance (Stage 2):** cached source location stays visible after reflow or history insertion; no argument/output disappears; omitted Markdown context can't exhaust a page budget; subagent controls respect host rights; full collaboration suite passes.

## Part B — Durable attachment and recovery (Stage 3, first half)

Goal: guest and host survive disconnects, client restarts, host restarts, compaction, branching and session changes without ever attaching to the wrong conversation or replaying side effects.

1. **Persistent endpoint/session profile (host + guest).** Introduce a private named host profile stored under the OMP config root (e.g. `remote/hosts/<profile>/`) containing the explicitly bound session file reference and stable credentials, written **before** the host accepts clients. Endpoint/session identity is persisted independently of invitation URLs and loopback ports. Never silently select an unrelated "latest" session — a missing or ambiguous binding is a hard error surfaced to the user.
2. **Persistent host command/service.** Add a host mode that loads the explicitly bound session via the existing runtime init (`createAgentSession` + `initializeExtensions` in `modes/runtime-init.ts`) and continues without a guest attached. Narrow `InteractiveModeContext` for `CollabHost` to its actual dependencies (session, sessionManager, event buses, status/UI sinks, pending-message display) instead of faking an interactive context; reuse central UI defaults and `requestGuestUi` for supported interactions.
3. **Host restart semantics.** On restart: restore session history, mark interrupted work clearly in the transcript/UI, and never automatically repeat tool side effects. Document that exactly-once external tool effects after a crash are not guaranteed.
4. **Original-prompt dedup fix.** Persist the **original prompt digest** with the request UUID; retries compare the original submission, not stored (possibly extension-rewritten) content.
5. **Event epoch/sequence and bounded replay journal.** Session-scoped epoch + sequence numbers; host keeps a bounded replay journal; guest detects gaps. When the journal no longer covers a gap, recover with bounded page/state refetch — never a full transcript download. Cover: lost ACKs, client restart, host restart, compaction, branching, session changes.
6. **Control-command ACK/retry semantics.** Define and implement retry/ACK for other control commands and UI responses; stale operations are rejected (epoch/sequence check).

**Tests:** lost-ACK retry with same request UUID; original-digest dedup with an extension that rewrites content; epoch/sequence gap detection → bounded recovery; wrong-session rejection on every change type (compaction, branch, switch, restart); persisted binding survives host restart; stale command rejection; no full-transcript fetch in any recovery path.

**Acceptance (Stage 3a):** guest and host can each restart, reattach to the correct conversation, reuse cached content, and never attach to the wrong session; prompt retries are exactly-once at the application layer (dedup by original digest).

## Part C — Authenticated Quinn QUIC sidecar (Stage 3, second half)

Goal: a packaged Rust sidecar providing the transport, connected to the durable host/guest from Part B, verified secure over loopback before any external exposure. No public address/hostname/port/router config.

1. **Rust workspace binary.** New crate in the existing Rust workspace (e.g. `crates/omp-remote-quic`) using Quinn 0.11.x, the pinned `nightly-2026-11-08` toolchain, existing Rust/Bun build conventions. Inspect cached Quinn/rustls/Tokio APIs before coding (Quinn 0.11.11, rustls 0.23.42). Adding Rust makes root checks run Rust checks; registry/cache writes may need sandbox escalation.
2. **Owner-only local IPC + lifecycle.** Unix-domain-socket IPC between OMP and the sidecar, restricted to the owner user; explicit lifecycle and error reporting to the host/guest commands. Wire it into the actual OMP host/guest commands (replacing/adapting the WebSocket path behind the same command surface).
3. **Transport identity vs. endpoint identity.** QUIC connection identity is separate from the persisted endpoint/session profile from Part B.
4. **Server pinning + client auth.** Server certificate/key pinning; per-client enrollment with an explicit allowlist of client credential fingerprints (shared CA alone is insufficient for revocation); revocation support; read-only authorization tier. Credential files private (owner-only permissions).
5. **Framing and limits.** Reliable bidirectional streams first; bounded application frames with explicit backpressure, frame/peer/connection limits, and timeouts. Unreliable datagrams and priority streams deferred until reliable operation is measured.
6. **First transport choice (assumption, low risk): tunnel the existing local collaboration WebSocket framing over one QUIC stream.** Rationale: reuses the entire existing protocol and Stage 1/2 client, smallest change. If the development relay is reused, extract a shared production implementation (no copy). Bind locally and authenticate host registration separately: an enrolled guest must never impersonate a host by changing the relay `role` parameter. Re-evaluate direct framed IPC only if the tunnel adds measurable overhead.
7. **Packaging/install.** Sidecar builds/installs so the command works outside a source checkout, following existing install/bundle conventions.
8. **Metrics.** Capture QUIC transport metrics (loss, RTT) separately from application timing; measure actual behavior before claiming any improvement.

**Tests:** valid authentication; wrong pin rejected; unknown/revoked client rejected; read-only tier rejects writes; oversized traffic bounded; disconnect/reconnect; process restart on both ends (over the QUIC path). All over loopback.

**Acceptance (Stage 3b):** the paged guest runs end-to-end over the sidecar on loopback with the security matrix above passing; transport metrics captured; no external exposure.

## Verification plan

Run in order after each part's changes:

```sh
export PATH=/tmp/omp-bun-1.4.4/package/bin:$PATH
cd /home/scotty/projects/oh-my-pi/packages/coding-agent
bun test test/collab/paged-history.test.ts test/collab/remote-state.test.ts test/collab/paged-guest.test.ts
bun test test/collab        # may need sandbox escalation (Unix sockets/file locks)
cd /home/scotty/projects/oh-my-pi
bun check                  # includes Rust half once Rust files change
bun run test:rs            # never invoke cargo test directly
```

After Part A: full collaboration suite must pass (previous baseline: 302 passed / 34 files / 1,580 assertions — historical, different code version; treat as a reference, not a target count). After Part C: add and run the sidecar loopback test matrix. Update docs and affected package CHANGELOGs at the end (Unreleased sections only); keep unfinished Stage 4–6 checkboxes unchecked. Fold or replace the incomplete `docs/remote-agent-implementation.md` outline with the completed implementation documentation.

## Explicit assumptions and defaults

- Scope is Stages 2 + 3 only, per user's choice; Stages 4–6 wait for a later request.
- Transport-first approach is WebSocket-over-QUIC-stream tunneling (low-risk default from the handoff's "one possible small first transport"); direct framed IPC is the evaluated alternative, revisited only on measured overhead.
- All names proposed above (crate name, host-profile directory layout, IPC socket location) are new decisions made here; prior discussion names were proposals only and are not assumed.
- The uncommitted diff is preserved and built upon; its renderer defects (the 10 listed in the handoff) are verified and fixed rather than reverted.
- No commits, deployments, external network exposure, or GitHub activity unless the user explicitly asks. Baseline test counts are historical references only.
