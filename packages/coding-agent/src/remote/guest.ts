import type { CollabUiRequest, GuestFrame } from "@oh-my-pi/pi-wire";
import { takeAutoRejoin } from "@oh-my-pi/pi-wire";
import { REMOTE_PROTOCOL_VERSION, type RemoteCursor } from "@oh-my-pi/pi-wire/remote";
import { matchesKey, type OverlayHandle } from "@oh-my-pi/pi-tui";
import type { AgentHubRemote, AgentHubRemoteTranscript } from "@oh-my-pi/pi-tui/overlays/agent-hub";
import { AgentHubOverlayComponent } from "@oh-my-pi/pi-tui/overlays/agent-hub";
import { SessionObserverRegistry } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import type { Terminal } from "@oh-my-pi/pi-tui/terminal";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { HookSelectorComponent } from "@oh-my-pi/pi-tui/overlays/hook-selector";
import { HookEditorComponent } from "@oh-my-pi/pi-tui/overlays/hook-editor";
import { parseSgrMouse } from "@oh-my-pi/pi-tui/mouse";
import { importRoomKey } from "../collab/crypto";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "../collab/protocol";
import { CollabSocket } from "../collab/relay-client";
import { CollabAgentMirror } from "../collab/agent-mirror";
import { agentTranscriptSource, createAgentHubRuntime } from "../modes/agent-hub-runtime";
import { RemoteViewport } from "./viewport";
import * as path from "node:path";
import { getConfigRootDir } from "@oh-my-pi/pi-utils/dirs";
import { postmortem } from "@oh-my-pi/pi-utils";
import { RemoteCapture } from "./capture";
import { startMacLocation } from "./mac-location";
import { RemoteStateStorage } from "./saved-state";
import { assertRemoteHistoryPage } from "./page-cache";
import { applyHistoryDelta, historyPageHash } from "./history-delta";
import type { RemotePrompt, RemoteHistoryPage } from "@oh-my-pi/pi-wire/remote";

/** Native paged guest with no local inference, session replica, or host cwd adoption. */
export async function runPagedGuest(link: string, terminal?: Terminal): Promise<void> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const composer = new Composer({
		terminal,
		preferences: {
			quiet: true,
			spellingTypoDetection: false,
			spellingAutocomplete: "off",
			spellingAutocorrect: false,
		},
	});
	const ui = composer.ui;
	const viewport = new RemoteViewport(
		() => ui.terminal.rows - composer.editor.render(ui.terminal.columns).length - 1,
		ui,
	);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
	const finished = Promise.withResolvers<void>();
	let closed = false;
	let readOnly = true;
	let revision: string | undefined;
	let latestRevision: string | undefined;
	/** Last applied paged-notification epoch/sequence: gap and restart detection. */
	let lastEpoch: number | undefined;
	let lastSeq: number | undefined;
	let sessionId: string | undefined;
	let requestId = 0;
	let pending:
		| { id: number; direction: "before" | "after"; replace: boolean; timer: Timer; base?: RemoteHistoryPage }
		| undefined;
	let allowReuse = true;
	const dialogs = new Map<number, OverlayHandle>();
	let capture: RemoteCapture | undefined;
	let stopLocation: (() => void) | undefined;
	let remoteCapturePending: "start" | "stop" | undefined;
	// Display-only mirror of the host's subagent ecosystem, feeding the Agent Hub.
	const agentMirror = new CollabAgentMirror();
	const hubObservers = new SessionObserverRegistry();
	/** Accumulated subagent transcript bytes per agent; the paged guest keeps history bounded. */
	const transcriptBytes = new Map<string, number>();
	const pendingTranscripts = new Map<
		number,
		{ agentId: string; resolve: (result: AgentHubRemoteTranscript | null) => void }
	>();
	let nextHubReqId = 1;
	let hubHandle: OverlayHandle | undefined;
	/** Total subagent transcript bytes a paged guest may pull; the viewer must not accumulate unbounded. */
	const PAGED_TRANSCRIPT_BYTES = 512 * 1024;
	const hubRemote: AgentHubRemote = {
		chat: (id, text) => {
			if (readOnly) return;
			send({ t: "agent-cmd", cmd: "chat", agentId: id, text });
		},
		kill: id => {
			if (readOnly) return;
			send({ t: "agent-cmd", cmd: "kill", agentId: id });
		},
		revive: id => {
			if (readOnly) return;
			send({ t: "agent-cmd", cmd: "revive", agentId: id });
		},
		readTranscript: (id, fromByte) => {
			if (!viewport.connected || agentMirror.hasTranscript(id) === false) return Promise.resolve(null);
			if ((transcriptBytes.get(id) ?? 0) >= PAGED_TRANSCRIPT_BYTES) {
				return Promise.resolve({
					text: "",
					newSize: fromByte,
					error: `subagent history is bounded to ${PAGED_TRANSCRIPT_BYTES} bytes in the paged guest`,
				});
			}
			const reqId = nextHubReqId++;
			const { promise, resolve } = Promise.withResolvers<AgentHubRemoteTranscript | null>();
			const timer = setTimeout(() => {
				pendingTranscripts.delete(reqId);
				resolve(null);
			}, 30_000);
			pendingTranscripts.set(reqId, { agentId: id, resolve });
			send({ t: "fetch-transcript", reqId, agentId: id, fromByte });
			return promise;
		},
	};
	const send = (frame: GuestFrame): boolean => {
		if (!socket.send(frame)) return false;
		capture?.record("request", {
			bytes: Buffer.byteLength(JSON.stringify(frame)),
			...("reqId" in frame ? { reqId: frame.reqId, history: frame.t === "history-fetch" } : {}),
		});
		return true;
	};
	const outbox = new Map<string, RemotePrompt>();
	const storage = new RemoteStateStorage(path.join(getConfigRootDir(), "remote", "guests"), link);
	let saveTimer: Timer | undefined;
	const rejoinBudget: number[] = [];
	const save = async (): Promise<boolean> => {
		try {
			await storage.write({
				version: 1,
				draft: composer.editor.getText(),
				sessionId,
				// The relay endpoint outlives invitation URLs and per-run ports.
				endpoint: parsed.wsUrl,
				pages: [...viewport.cache.pages],
				prompts: [...outbox.values()],
			});
			return true;
		} catch {
			viewport.status = "Remote draft could not be saved";
			ui.requestRender();
			return false;
		}
	};
	const scheduleSave = (): void => {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			void save();
		}, 300);
	};
	try {
		const saved = await storage.load();
		if (saved) {
			composer.editor.setText(saved.draft);
			sessionId = saved.sessionId;
			for (const page of saved.pages) viewport.cache.put(page, "after");
			revision = viewport.cache.pages[0]?.revision;
			for (const prompt of saved.prompts) outbox.set(prompt.id, prompt);
		}
	} catch {
		viewport.status = "Saved remote state could not be loaded";
	}
	composer.editor.onChange = scheduleSave;
	const clearPending = (): void => {
		if (pending) clearTimeout(pending.timer);
		pending = undefined;
		viewport.loading = undefined;
	};
	const fetch = (direction: "before" | "after", cursor?: RemoteCursor): void => {
		if (!viewport.connected || pending) return;
		const id = ++requestId;
		const base = !cursor && allowReuse ? viewport.cache.pages.at(-1) : undefined;
		viewport.loading = direction;
		viewport.error = undefined;
		pending = {
			id,
			direction,
			replace: cursor === undefined,
			base,
			timer: setTimeout(() => {
				clearPending();
				viewport.error = "History request timed out";
				ui.requestRender();
			}, 30_000),
		};
		if (
			!send({
				t: "history-fetch",
				reqId: id,
				revision: cursor ? revision : undefined,
				direction,
				cursor,
				have: base ? historyPageHash(base) : undefined,
			})
		) {
			clearPending();
			viewport.error = "History request could not be sent";
		}
		ui.requestRender();
	};
	viewport.request = fetch;
	const close = (): void => {
		if (closed) return;
		closed = true;
		clearTimeout(saveTimer);
		stopLocation?.();
		void capture?.stop();
		clearPending();
		if (hubHandle) {
			hubHandle.hide();
			hubHandle = undefined;
		}
		agentMirror.clear();
		for (const dialog of dialogs.values()) dialog.hide();
		dialogs.clear();
		socket.close();
		composer.stop();
		finished.resolve();
	};
	/** Open the Agent Hub over the host's mirrored subagent ecosystem. */
	const openAgentHub = (): void => {
		if (hubHandle) return;
		let closedHub = false;
		const hub = new AgentHubOverlayComponent({
			...createAgentHubRuntime({ registry: agentMirror.registry, remote: hubRemote, loadPersisted: async () => {} }),
			observers: hubObservers,
			hubKeys: ["ctrl+a"],
			onDone: () => {
				if (closedHub) return;
				closedHub = true;
				hub.dispose();
				hubHandle?.hide();
				hubHandle = undefined;
				ui.requestRender();
			},
			requestRender: () => ui.requestRender(),
			remote: hubRemote,
			ui,
		});
		hubHandle = ui.showOverlay(hub, { fullscreen: true });
		ui.requestRender();
	};
	const ask = (request: CollabUiRequest): void => {
		if (readOnly || dialogs.has(request.reqId)) return;
		const answer = (value?: string): void => {
			dialogs.get(request.reqId)?.hide();
			dialogs.delete(request.reqId);
			if (viewport.connected) send({ t: "ui-response", reqId: request.reqId, value });
		};
		const component =
			request.kind === "select"
				? new HookSelectorComponent(
						request.title,
						request.options,
						value => answer(value),
						() => answer(),
						{
							tui: ui,
							initialIndex: request.initialIndex,
							selectionMarker: request.selectionMarker,
							checkedIndices: request.checkedIndices,
							markableCount: request.markableCount,
							helpText: request.helpText,
						},
					)
				: new HookEditorComponent(
						ui,
						request.title,
						request.prefill,
						value => answer(value),
						() => answer(),
					);
		dialogs.set(request.reqId, ui.showOverlay(component, { fullscreen: true }));
	};
	const apply = (incoming: CollabFrame): void => {
		capture?.record("response", {
			bytes: Buffer.byteLength(JSON.stringify(incoming)),
			...("reqId" in incoming
				? {
						reqId: incoming.reqId,
						history:
							incoming.t === "history-page" ||
							incoming.t === "history-delta" ||
							incoming.t === "history-changed",
					}
				: {}),
		});
		let frame = incoming;
		if (frame.t === "history-delta") {
			if (frame.reqId !== pending?.id || !pending.base) return;
			try {
				frame = applyHistoryDelta(pending.base, frame);
			} catch {
				allowReuse = false;
				clearPending();
				viewport.error = "Invalid history delta · Ctrl+End to reload";
				viewport.status = viewport.error;
				ui.requestRender();
				return;
			}
		}
		if (frame.t === "welcome") {
			if (frame.history?.version !== REMOTE_PROTOCOL_VERSION) {
				finished.reject(
					new Error("This host does not support paged history; update the host or use ordinary omp join"),
				);
				close();
				return;
			}
			clearPending();
			readOnly = frame.readOnly === true;
			viewport.connected = true;
			if (capture && remoteCapturePending && !readOnly)
				send({ t: "capture-control", id: capture.id, action: remoteCapturePending, epoch: lastEpoch });
			viewport.status = `${frame.state.sessionName ?? "Remote session"} · ${frame.state.isStreaming ? "working" : "idle"}`;
			if (sessionId !== undefined && sessionId !== frame.history.sessionId) {
				viewport.cache.clear();
				viewport.live();
				agentMirror.clear();
				transcriptBytes.clear();
				for (const prompt of outbox.values()) {
					if (prompt.sessionId === frame.history.sessionId) continue;
					outbox.delete(prompt.id);
					restoreDraft(prompt.text);
				}
				viewport.status = "Session changed · previous pending text returned to draft";
			}
			sessionId = frame.history.sessionId;
			agentMirror.apply(frame.agents ?? []);
			for (const prompt of outbox.values()) if (prompt.sessionId === sessionId && !readOnly) send(prompt);
			latestRevision = frame.history.revision;
			if (viewport.followsLive || !viewport.cache.pages.length) fetch("before");
		} else if (frame.t === "history-page" && frame.reqId === pending?.id && frame.sessionId === sessionId) {
			try {
				assertRemoteHistoryPage(frame);
			} catch {
				clearPending();
				viewport.error = "Invalid history response";
				viewport.status = viewport.error;
				ui.requestRender();
				return;
			}
			const direction = pending.direction;
			const replace = pending.replace;
			clearPending();
			if (replace) {
				viewport.cache.clear();
				revision = frame.revision;
				allowReuse = true;
			}
			if (frame.revision !== revision) return;
			viewport.cache.put(frame, direction);
			scheduleSave();
			capture?.record("sample", { cacheBytes: viewport.cache.bytes, cachePages: viewport.cache.pages.length });
			if (viewport.followsLive && latestRevision !== frame.revision) fetch("before");
		} else if (frame.t === "history-changed") {
			if (frame.sessionId !== sessionId) return;
			latestRevision = frame.revision;
			// Epoch/sequence gap detection: the host numbers every notification
			// within an epoch that bumps on room recreation and structural
			// transcript changes. A skipped or regressed sequence means lost
			// notifications (or a restarted host); the bounded recovery is always
			// a page refetch, never a transcript download.
			const structuralChange = frame.epoch !== undefined && (lastEpoch === undefined || frame.epoch !== lastEpoch);
			const sequenceRegression =
				frame.seq !== undefined && lastSeq !== undefined && frame.epoch === lastEpoch && frame.seq <= lastSeq;
			const sequenceGap =
				frame.seq !== undefined && lastSeq !== undefined && frame.epoch === lastEpoch && frame.seq > lastSeq + 1;
			if (frame.epoch !== undefined) lastEpoch = frame.epoch;
			if (frame.seq !== undefined) lastSeq = frame.seq;
			if (frame.reqId === pending?.id) {
				clearPending();
				viewport.error = "History changed · Ctrl+End to reload";
			}
			if (viewport.followsLive) {
				fetch("before");
			} else if (structuralChange || sequenceRegression || sequenceGap)
				viewport.status = "Missed updates · Ctrl+End to return to live";
			else viewport.status = "New activity · Ctrl+End to return to live";
		} else if (frame.t === "state") {
			viewport.status = `${frame.state.sessionName ?? "Remote session"} · ${frame.state.isStreaming ? "working" : "idle"}`;
		} else if (frame.t === "prompt-status") {
			const prompt = outbox.get(frame.id);
			if (prompt && frame.status !== "pending") {
				outbox.delete(frame.id);
				if (frame.status === "rejected") {
					const draft = composer.editor.getText();
					composer.editor.setText(draft ? `${draft}\n\n${prompt.text}` : prompt.text);
					viewport.status = "Prompt rejected · text returned to draft";
				}
				scheduleSave();
			}
		} else if (frame.t === "capture-status" && frame.id === capture?.id) {
			remoteCapturePending = undefined;
			viewport.status =
				frame.error ?? `Capture ${frame.active ? "recording on both endpoints" : "stopped on server"}`;
		} else if (frame.t === "transcript") {
			const pending = pendingTranscripts.get(frame.reqId);
			if (pending) {
				pendingTranscripts.delete(frame.reqId);
				if (!frame.error)
					transcriptBytes.set(
						pending.agentId,
						(transcriptBytes.get(pending.agentId) ?? 0) + Buffer.byteLength(frame.text),
					);
				pending.resolve({ text: frame.text, newSize: frame.newSize, error: frame.error });
			}
		} else if (frame.t === "agents") {
			agentMirror.apply(frame.agents);
		} else if (frame.t === "ui-request") ask(frame.request);
		else if (frame.t === "ui-request-end") {
			dialogs.get(frame.reqId)?.hide();
			dialogs.delete(frame.reqId);
		} else if (frame.t === "bye") {
			socket.close();
			clearPending();
			viewport.connected = false;
			viewport.status = `Session ended: ${frame.reason} · Ctrl+C to exit`;
		} else if (frame.t === "error") {
			clearPending();
			viewport.error = frame.message;
			viewport.status = frame.message;
			if (frame.resync && takeAutoRejoin(rejoinBudget)) {
				viewport.connected = false;
				introduce();
			}
		}
		ui.requestRender();
	};
	const introduce = (): void => {
		send({
			t: "hello",
			proto: COLLAB_PROTO,
			name: "Remote",
			writeToken: parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined,
			pagedHistory: true,
		});
	};
	socket.onOpen = () => {
		capture?.record("connected");
		introduce();
	};
	socket.onFrame = apply;
	socket.onTraffic = (sent, bytes, bufferedBytes) => capture?.record("transport", { sent, bytes, bufferedBytes });
	socket.onClose = (reason, retry) => {
		capture?.record("disconnected", { retry });
		viewport.connected = false;
		viewport.status = `${retry ? "Reconnecting" : "Disconnected"}: ${reason} · draft retained`;
		clearPending();
		for (const dialog of dialogs.values()) dialog.hide();
		dialogs.clear();
		ui.requestRender();
	};
	composer.editor.disableSubmit = false;
	composer.editor.onExit = close;
	const restoreDraft = (text: string): void => {
		const current = composer.editor.getText();
		composer.editor.setText(current ? `${text}\n\n${current}` : text);
		scheduleSave();
	};
	composer.editor.onSubmit = async text => {
		if (/^\/capture(?:\s|$)/.test(text)) {
			const [, action, ...rest] = text.split(/\s+/);
			try {
				if (action === "start") {
					if (capture && !capture.status.closed) throw new Error("Capture is already recording");
					capture = await RemoteCapture.start({
						id: crypto.randomUUID(),
						role: "client",
						directory: path.join(getConfigRootDir(), "remote", "captures"),
					});
					if (closed) {
						await capture.stop();
						return;
					}
					remoteCapturePending = "start";
					if (rest.includes("--location"))
						stopLocation = await startMacLocation(capture, status => {
							viewport.status = status;
							ui.requestRender();
						});
				} else if (action === "stop" && capture) {
					stopLocation?.();
					stopLocation = undefined;
					await capture.stop();
					remoteCapturePending = "stop";
				} else if (action === "mark" && capture) {
					capture.record("mark", undefined, rest.join(" "));
					if (viewport.connected)
						send({
							t: "capture-control",
							id: capture.id,
							action: "mark",
							mark: rest.join(" "),
							epoch: lastEpoch,
						});
				} else if (action !== "status")
					throw new Error("Usage: /capture start [--location] | stop | mark <note> | status");
				if (capture && remoteCapturePending && viewport.connected && !readOnly)
					send({ t: "capture-control", id: capture.id, action: remoteCapturePending, epoch: lastEpoch });
				viewport.status = capture
					? `Capture ${capture.id} · ${capture.status.bytes} bytes · ${remoteCapturePending ? `server ${remoteCapturePending} pending` : capture.status.closed ? "stopped" : "recording"}`
					: "No active capture";
			} catch (error) {
				viewport.status = String(error);
			}
			ui.requestRender();
			return;
		}
		if (!viewport.connected || readOnly) {
			composer.editor.setText(text);
			viewport.status = readOnly
				? parsed.writeToken
					? "Read-only session · draft retained"
					: "Read-only session · this link is view-only · draft retained"
				: "Offline · draft retained";
		} else {
			if (outbox.size >= 16 || Buffer.byteLength(text) > 64 * 1024 || !sessionId) {
				composer.editor.setText(text);
				viewport.status = "Prompt not sent · pending queue or prompt byte limit reached";
			} else {
				const prompt: RemotePrompt = { t: "remote-prompt", id: crypto.randomUUID(), sessionId, text };
				outbox.set(prompt.id, prompt);
				if (!(await save())) {
					outbox.delete(prompt.id);
					restoreDraft(text);
					ui.requestRender();
					return;
				}
				if (closed) return;
				if (!send(prompt)) {
					outbox.delete(prompt.id);
					restoreDraft(text);
				}
				scheduleSave();
			}
		}
		ui.requestRender();
	};
	ui.addInputListener(data => {
		if (matchesKey(data, "ctrl+a") && !ui.hasOverlay()) {
			openAgentHub();
			return { consume: true };
		}
		if (ui.hasOverlay()) return;
		if (matchesKey(data, "ctrl+c")) {
			close();
			return { consume: true };
		}
		if (matchesKey(data, "escape")) {
			if (viewport.connected && !readOnly) send({ t: "abort" });
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+end")) {
			viewport.live();
			clearPending();
			fetch("before");
			return { consume: true };
		}
		const mouse = parseSgrMouse(data);
		if (mouse?.wheel || matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
			const delta = mouse?.wheel
				? mouse.wheel * 3
				: matchesKey(data, "pageUp")
					? -Math.max(1, ui.terminal.rows - 6)
					: Math.max(1, ui.terminal.rows - 6);
			viewport.scroll(delta);
			ui.requestRender();
			return { consume: true };
		}
	});
	composer.setRuntimeChildren([viewport, composer.editor]);
	ui.setInlineMouseTrackingProvider(() => true);
	const unregister = postmortem.register(
		"paged-remote-guest",
		async () => {
			close();
			await save();
			await capture?.stop();
		},
		{ exitOnly: true },
	);
	try {
		composer.start();
		socket.connect();
		await finished.promise;
	} finally {
		unregister();
		close();
		await save();
		await capture?.stop();
	}
}
