# Handover: Poor-Network Remote Coding Agent — OMP + Herdr

**Status:** Architecture investigation underway. No implementation has been started.

**Last updated:** 17 November 2026

## 1. Goal

Build a remote coding-agent experience that remains responsive and usable over unreliable mobile connectivity, particularly during train commutes with intermittent 5G and Wi-Fi.

The system should run the authoritative coding agent, tools, workspace and conversation history on a Linux desktop, while a MacBook Pro runs a native terminal client that renders and navigates the conversation locally.

The client must not depend on continuously receiving terminal screen updates.

The intended end state is integration with **Herdr**, an agent-aware terminal multiplexer, supporting multiple remote agent panes. Start with a single agent pane.

The defining feature is **bounded, demand-paged transcript synchronization**: the client caches a small portion of the conversation, fetches earlier or later portions as needed, and continues to display cached content during disconnections.

This is not intended to be a generic SSH, Mosh or remote-PTY replacement.

## 2. Machines and environment

### Client

- **Hardware:** MacBook Pro
- **OS:** macOS
- **Terminal emulator:** Ghostty
- **Intended applications:** OMP remote guest TUI, eventually inside Herdr
- **Connectivity:** Unreliable train Wi-Fi and mobile 5G
- **Secondary future client:** Android

### Server

- **Hardware:** Linux home desktop
- **OS:** Linux
- **Networking:** Residential connection with a static public IP address
- **Intended applications:** Persistent OMP agent runtime, QUIC server, local workspace and session storage
- **Router configuration:** Direct inbound UDP port forwarding proposed
- **Hostname:** Not established in the available discussion

### Feynman

The user referred to **Feynman** as the environment containing another ChatGPT project named **Trash**.

Do not assume that Feynman is the Linux server hostname without verification.

### Paths and configuration

No local checkout paths, home directories, configuration-file locations, credentials, certificates, public IP address or router forwarding rules have been established for this project.

Do not invent them.

The following are confirmed upstream repository paths, not local filesystem paths:

- `https://github.com/can1357/oh-my-pi`
- `packages/coding-agent/src/collab/host.ts`
- `packages/coding-agent/src/collab/guest.ts`
- `packages/coding-agent/src/collab/protocol.ts`
- `packages/coding-agent/src/collab/relay-client.ts`
- `packages/coding-agent/src/collab/controller.ts`
- `packages/coding-agent/src/collab/registry.ts`
- `packages/coding-agent/src/collab/replication-shrink.ts`
- `docs/collab.md`
- `packages/collab-web/`

The original Pi repository is `https://github.com/badlogic/pi-mono`.

The Rust alternative previously considered is `pi_agent_rust` by Dicklesworthstone.

## 3. Architectural decisions

### 3.1 Agent and UI separation

The server is authoritative for:

- Agent execution and model calls
- Tool execution and filesystem operations
- Complete persistent conversation history
- Session identity, branching and compaction
- Durable conversation events

The client owns:

- Native terminal rendering
- Local editor and interaction
- Viewport and scroll position
- Bounded transcript cache
- Fetch scheduling and prefetch
- Connection status and recovery UI

The client must not treat its incomplete transcript cache as the agent's authoritative context.

### 3.2 OMP is the leading candidate

We initially considered modifying original Pi, then `pi_agent_rust`, then OMP (Oh My Pi).

OMP is currently preferred for investigation because it already implements a remote guest TUI that renders a host's agent session natively.

OMP is primarily TypeScript/Bun, with Rust native components.

This is a provisional choice, not a final commitment.

### 3.3 Herdr integration

Both OMP and Herdr will probably require changes.

OMP should own:

- Agent-specific remote protocol
- Transcript synchronization
- Remote guest TUI
- Agent commands and events
- Session lifecycle and recovery

Herdr should own:

- Pane orchestration
- Pane layout and focus
- Agent process/session lifecycle
- Agent state indicators
- Multi-pane prioritization

For the first integration, Herdr can launch the modified OMP guest in a **local PTY**. This avoids immediately embedding OMP's TUI renderer into Herdr.

A future Herdr pane-backend abstraction might distinguish `Pty` from `RemoteAgent`, without hard-coding OMP-specific behaviour.

### 3.4 Transport

Selected direction: **QUIC using Rust Quinn 0.11.x**.

Reasons include stream multiplexing, congestion control, support for network migration, and optional unreliable datagrams.

Proposed topology:

MacBook OMP client → direct QUIC → Linux desktop OMP host

Avoid requiring Tailscale for ordinary operation. The user has experienced unreliable networking with Tailscale installed, even without an exit node.

Security requirements:

- Retain TLS server authentication.
- Pin the server certificate or public key.
- Authenticate clients.
- Maintain persistent session/client identity independently of a particular QUIC connection.
- Do not rely solely on being inside a private network.

Initial network configuration: direct connection to the static public IP, with router UDP forwarding.

A relay fallback is deferred.

**Port 4433/UDP** was discussed as an example for testing, not confirmed as the production port.

For integrating Quinn with OMP, the current preference is a **standalone Rust QUIC sidecar** using local IPC to OMP. This is a proposal, not an implementation decision that has been tested. A Rust N-API module is an alternative for later integration.

### 3.5 Transcript model

Initial scope: one linear conversation transcript.

Later generalize to branching conversation trees and multiple Herdr panes.

Desired properties:

- Stable transcript identity
- Stable ordering of committed messages/blocks
- Immutable committed history where possible
- Mutable live streaming tail
- Arbitrary range retrieval
- Sparse local replica
- Bounded cache
- Reconnection without retransmitting the entire conversation
- Explicit invalidation or revision changes when branching/compaction changes the visible transcript

An earlier conceptual structure was:

```rust
struct SparseTranscript {
    transcript_id: /* stable identity */,
    head_seq: u64,
    blocks: BTreeMap<u64, TranscriptBlock>,
}
```

This is conceptual pseudocode, not implemented or type-complete Rust.

The design must account for OMP's actual session semantics rather than blindly imposing an append-only sequence.

### 3.6 Chunking and scrolling

The user chose **three bounded transcript chunks** as the initial cache concept.

Chunks should be based on semantic message boundaries or serialized bytes, not terminal rows.

Reasons:

- Terminal width can change.
- Messages reflow locally.
- A chunk should remain identifiable regardless of viewport geometry.

Do not require an accurate global scrollbar.

Scrolling should stop at an uncached boundary while a fetch is pending, rather than unexpectedly jumping when data arrives.

A separate explicit jump command may be introduced.

The client should prefetch nearby history, prioritizing the active viewport.

### 3.7 Status UI

The user wants static rows at the top and bottom of the pane showing useful remote-state information.

Candidate information:

- Whether earlier/later history is cached
- Active transcript fetches
- Connection state
- Estimated bandwidth
- Packet loss
- Reconnection status

The status rows must not consume excessive screen space.

### 3.8 Network reliability

Use reliable QUIC streams for:

- Commands and acknowledgements
- Durable events
- Requested transcript history
- Session changes
- Gap recovery

Unreliable QUIC datagrams may be useful for speculative transcript prefetch/backfill.

However, do not assume datagrams are automatically faster. They still share congestion control and introduce loss, fragmentation and retry concerns.

Prioritize correctness for requested history and agent control.

The remote agent must continue executing when the client disconnects.

A brief network address change may be handled by QUIC connection migration; longer outages require application-level reattachment and recovery.

## 4. OMP investigation: verified findings

Repository:

`https://github.com/can1357/oh-my-pi`

Documentation inspected:

`https://github.com/can1357/oh-my-pi/blob/main/docs/collab.md`

### 4.1 Existing collaboration

OMP's `/collab` shares a running session with another OMP instance.

The guest renders the session **natively in its own TUI**, rather than mirroring terminal screen output.

The host runs the agent and all tools.

The guest can submit prompts, interrupt the agent and participate in supported UI interactions.

The existing transport uses a WebSocket relay.

Documented commands include:

```text
/collab
/collab view
/collab status
/collab stop
/collab list
/join <link>
/leave
```

CLI examples:

```bash
omp collab list
omp collab list --json
omp collab link <instanceId|pid>
omp collab link <instanceId> --view
omp join "<link>"
```

These commands were found in documentation. **They have not been executed on the user's machines.**

### 4.2 Existing host/guest implementation

`packages/coding-agent/src/collab/host.ts`

- Observes host session events.
- Hooks session entry appends.
- Serializes durable entries.
- Builds initial snapshots.
- Supports guest requests and agent control.
- Contains incremental subagent transcript serving.

`packages/coding-agent/src/collab/guest.ts`

- Receives host snapshots and live events.
- Reconstructs a local replica using `SessionManager`.
- Updates agent message state through `agent.replaceMessages()`.
- Uses OMP's normal TUI to render the replicated session.
- Handles guest-side synchronization and restoration.

`packages/coding-agent/src/collab/protocol.ts`

Defines frames including:

```text
welcome
snapshot-chunk
entry
event
agents
transcript
error
```

The guest-to-host protocol also includes `fetch-transcript`.

### 4.3 Snapshot behaviour

Confirmed in `host.ts`:

```ts
const SNAPSHOT_CHUNK_BYTES = 512 * 1024;
```

Initial snapshots are split into approximately 512 KiB byte-bounded frames.

This does **not** provide demand paging. The guest accumulates the snapshot until complete before finalizing the local replica.

The existing `welcome` carries an entry count and metadata; `snapshot-chunk` frames deliver the entries.

### 4.4 Subagent transcript fetching

Confirmed in `host.ts`:

```ts
export const TRANSCRIPT_READ_CAP = 4 * 1024 * 1024;
```

OMP already supports incremental **subagent** transcript reads using a request ID, agent ID and `fromByte` offset.

This is useful prior art for bounded request/response transfer, but it is not main-session transcript paging.

### 4.5 Reconnection behaviour

The guest currently discards incomplete snapshots during resynchronization.

The host can request rejoining/resynchronization if a guest's backlog is discarded.

This is unsuitable as-is for our objective: a large conversation must not be retransmitted in full after every poor-network interruption.

We need cache reuse, revision validation, event cursors and bounded gap recovery.

### 4.6 Session registry

OMP has a local host registry.

Documented metadata includes:

- Stable process instance ID
- Room generation
- PID
- Session ID and name
- Working directory
- Model
- Start time
- Participant count
- Connection state
- Whether input is required
- Busy/idle state
- Access level

On macOS/Linux, the registry uses local Unix-domain-socket IPC and metadata under:

```text
~/.omp/run/collab-hosts
```

This path is OMP's documented runtime registry location, not a path created or inspected on the user's machines.

Herdr could use similar information for orchestration, but remote discovery will require additional design.

### 4.7 Room lifecycle

OMP collaboration rooms follow sessions, not processes.

Operations such as `/new`, `/resume`, `/fork` and branching may retire a room and establish another.

Our system needs persistent endpoint/session identity independent of ephemeral collaboration room links.

We must investigate how best to preserve OMP's existing lifecycle behaviour while enabling durable remote attachment.

## 5. Source retrieval performed

The investigation used the GitHub connector to retrieve public upstream files and repository directories.

Successful requests included:

```text
GET https://api.github.com/repos/can1357/oh-my-pi/contents/docs/collab.md

GET https://api.github.com/repos/can1357/oh-my-pi/contents/packages/coding-agent/src/collab

GET https://api.github.com/repos/can1357/oh-my-pi/contents/packages/coding-agent/src/collab/host.ts

GET https://api.github.com/repos/can1357/oh-my-pi/contents/packages/coding-agent/src/collab/guest.ts

GET https://api.github.com/repos/can1357/oh-my-pi/contents/packages/coding-agent/src/collab/protocol.ts
```

The source files were inspected through returned text and selected line excerpts.

Some previous attempts to retrieve original Pi source files through GitHub's file interface failed with HTTP 400/file metadata errors.

An attempted OMP path:

```text
packages/pi-wire
```

returned 404. Do not assume that path exists in the current tree.

**No `git clone`, build, test, benchmark, local shell command, deployment or network test has been performed for this project.**

No source modifications, commits, branches or pull requests have been created.

## 6. Network impairment testing plan

Before relying on real train connectivity, build a deterministic UDP impairment proxy in Rust.

Run it locally on the MacBook:

```text
OMP client
    ↓ localhost UDP
Rust impairment proxy
    ↓ Internet
Linux QUIC server
```

The proxy should support independently configurable upstream/downstream impairment:

- Fixed latency
- Jitter
- Random packet loss
- Burst loss
- Packet reordering
- Duplication
- Bandwidth throttling
- Complete outages
- Deterministic seeded scenarios
- Per-direction counters and measurements

An illustrative test arrangement discussed was:

```text
localhost:4433 → remote-public-IP:4433/UDP
```

This is not an established running configuration.

Alternative platform tools:

- macOS `pf` / `dnctl`
- Linux `tc netem`

Toxiproxy was rejected as a direct fit because its normal impairment model is TCP-oriented.

The proxy does not reproduce real QUIC path migration because it masks changes in the client's network endpoint. Test migration separately.

## 7. Remaining investigation — highest priority

### A. OMP TUI and partial-history coupling

This is the most important unresolved question.

Determine:

1. How does the TUI obtain the list of messages to render?
2. Does it require the entire transcript in memory?
3. Can the visible transcript be represented as a sparse set of entries?
4. How does scroll position work?
5. Can it preserve a stable viewport anchor when new history is inserted?
6. Can it render cached messages while older messages are unavailable?
7. Does terminal resizing reflow messages without invalidating transcript identity?
8. What extension/UI features assume complete session history?
9. Can partial transcript display be separated from the agent's authoritative message state?

Inspect the actual rendering and scrollback code, not just the collaboration modules.

### B. Minimal OMP prototype

Before adding QUIC, implement a narrowly scoped proof of concept:

**Join a remote OMP session while transferring only a bounded recent suffix of the main transcript, and preserve normal live-event rendering.**

Use the existing collaboration transport initially.

Test:

- Long sessions
- Tool output
- Streaming assistant responses
- Reconnect
- Resizing
- Scrolling to missing history
- Session branching/compaction
- Extension UI interactions

The first milestone is architectural feasibility, not network performance.

### C. Main-session history API

Design and implement:

- Stable transcript and revision identity
- Range/chunk requests
- Stable cursors
- Explicit missing-range representation
- Bounded cache eviction
- Viewport-oriented prefetch
- Streaming-tail updates
- Recovery after event gaps
- Branch/compaction invalidation
- Reconnect without full snapshot

Do not directly repurpose subagent `fetch-transcript` without examining its assumptions.

### D. Persistent server lifecycle

Investigate how to run OMP as a durable remote service.

Verify:

- Agent continues when client disconnects.
- Agent survives guest TUI termination.
- Client can reattach without a new invitation link.
- Session selection works after client restart.
- Host process termination/restart has defined recovery behaviour.
- Session switching does not accidentally attach to the wrong conversation.

### E. QUIC transport

Once the history model is viable:

- Prototype Quinn transport, likely with a Rust sidecar.
- Define IPC between TypeScript OMP and Rust.
- Add mutual identity/authentication requirements.
- Implement connection resume and event recovery.
- Measure latency, throughput, CPU cost and memory.
- Evaluate whether unreliable datagrams actually improve speculative backfill.

### F. Herdr integration

After standalone remote OMP works:

- Inspect Herdr's actual pane and process architecture.
- Identify its upstream repository and version.
- Launch the local OMP guest in one Herdr-managed PTY.
- Expose session working/idle/blocked state.
- Add remote-session lifecycle and reconnection.
- Later introduce multi-pane scheduling.

For multi-pane prioritization:

1. Active pane viewport and interaction
2. Panes waiting for user input
3. Recent or likely-to-be-visited panes
4. Lower-priority speculative transcript history

Priorities should adapt to focus and agent state.

## 8. Key risks and unresolved choices

**Partial history versus OMP's session model:** The existing guest uses `SessionManager` and `agent.replaceMessages()`. A sparse transcript must not corrupt or misrepresent agent context.

**Branching:** The initial linear transcript model is intentionally simplified. It must not make future branching prohibitively difficult.

**Extension compatibility:** OMP's native guest already supports interactive agent features. The new synchronization architecture must preserve them.

**Transport complexity:** QUIC is selected, but a separate Rust sidecar introduces packaging, IPC and lifecycle overhead. Measure before making it permanent.

**Upstream maintenance:** OMP is a substantial, evolving fork. Prefer narrowly scoped changes and preserve upstream collaboration behaviour where possible.

**Network security:** Direct exposure of a home machine requires properly authenticated QUIC, authorization and secure handling of credentials.

**Session discovery:** The existing registry is local. Remote enumeration and attachment need a secure protocol.

## 9. Recommended next action for the coding assistant

Clone the current upstream OMP repository into an isolated workspace.

Record:

- Exact upstream commit SHA
- Repository instructions
- Relevant package versions
- TUI rendering and scrolling entry points
- Session manager/replica dependencies
- Existing collaboration tests

Then produce a **source-backed feasibility report** answering:

> Can OMP's existing native guest TUI render and navigate a sparse, bounded main-session transcript without loading the complete session, and what is the smallest refactor required?

Identify exact files, functions and data structures that must change.

Do not begin with QUIC or Herdr. First establish that partial transcript rendering is feasible.

If the refactor is modest, proceed with a small prototype using the existing WebSocket collaboration transport. If the refactor is extensive, compare that cost against original Pi and `pi_agent_rust` before committing.

## 10. Deliverables and working constraints

For the next investigation, deliver:

- Exact upstream revision
- Source-level architecture map
- Identified coupling points
- Minimal proposed interface changes
- Risks to existing behaviour
- Proposed regression tests
- A concrete implementation sequence

Distinguish verified facts, assumptions and proposals.

Do not claim performance benefits without measurements.

No authorization has been given to push changes, open pull requests, change network configuration or deploy services.

**Current overall conclusion:** OMP is the strongest candidate identified so far because it already supports native remote session replication. The main remaining feasibility question is whether its TUI can support a bounded, sparse transcript cache without extensive redesign.
