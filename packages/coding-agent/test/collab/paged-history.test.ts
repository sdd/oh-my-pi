import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { REMOTE_PAGE_BYTES, type RemoteHistoryPage } from "@oh-my-pi/pi-wire/remote";
import { RemoteHistory } from "../../src/remote/history";
import { RemotePageCache } from "../../src/remote/page-cache";
import { applyHistoryDelta, encodeHistoryDelta, historyPageHash } from "../../src/remote/history-delta";
import type { SessionEntry } from "../../src/session/session-entries";
import { CollabHost } from "../../src/collab/host";
import { CollabSocket } from "../../src/collab/relay-client";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "../../src/collab/protocol";
import { importRoomKey } from "../../src/collab/crypto";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";
import { makeHostContext, waitFor } from "./helpers/throttled-host";
import type { InteractiveModeContext } from "../../src/modes/types";
import type { AgentSessionEvent } from "../../src/session/agent-session";
import { RemoteCapture } from "../../src/remote/capture";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

function entry(id: string, text: string, parentId: string | null = null): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-11-17T00:00:00Z",
		message: { role: "user", content: text, timestamp: 0 },
	};
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	uninstallInMemoryRelay();
	vi.restoreAllMocks();
});

async function pagedHost(writable = false): Promise<{
	ctx: InteractiveModeContext;
	guest: CollabSocket;
	frames: CollabFrame[];
	emit: (event: AgentSessionEvent) => void;
}> {
	installInMemoryRelay();
	const snapshot = {
		header: { type: "session" as const, id: "s", timestamp: "2026-11-17", cwd: "/tmp" },
		entries: [entry("large", "large history ".repeat(30_000))],
	};
	const ctx = makeHostContext(snapshot, { notices: [], participantCounts: [] });
	ctx.sessionManager.getReplicationRevision = () => "r1";
	ctx.sessionManager.getBranch = () => [...snapshot.entries];
	let emit: (event: AgentSessionEvent) => void = () => {};
	const subscribe = ctx.session.subscribe.bind(ctx.session);
	spyOn(ctx.session, "subscribe").mockImplementation(listener => {
		emit = listener;
		return subscribe(listener);
	});
	const host = new CollabHost(ctx);
	cleanups.push(() => host.stop("test finished"));
	await host.start("ws://localhost:8788");
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	const guest = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
	cleanups.push(() => guest.close());
	const frames: CollabFrame[] = [];
	guest.onFrame = frame => frames.push(frame);
	guest.onOpen = () =>
		guest.send({
			t: "hello",
			proto: COLLAB_PROTO,
			name: "paged",
			pagedHistory: true,
			writeToken: writable && parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined,
		});
	guest.connect();
	await waitFor(() => frames.some(frame => frame.t === "welcome"), "welcome");
	return { ctx, guest, frames, emit: event => emit(event) };
}

describe("bounded structured history", () => {
	it("retrieves a message larger than the cache in both directions without losing Unicode or JSON escapes", () => {
		const text = '🤖漢字\\\"\n'.repeat(40_000);
		const history = new RemoteHistory("session", "revision", [entry("large", text)]);
		let page = history.page(0, "after");
		let forward = "";
		let count = 0;
		while (true) {
			expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(REMOTE_PAGE_BYTES);
			forward += page.fragments.map(fragment => fragment.text).join("");
			if (!page.after) break;
			page = history.page(++count, "after", page.after);
		}
		expect(forward).toBe(text);
		expect(count).toBeGreaterThan(3);
		page = history.page(0, "before");
		let backward = "";
		while (true) {
			backward = page.fragments.map(fragment => fragment.text).join("") + backward;
			if (!page.before) break;
			page = history.page(++count, "before", page.before);
		}
		expect(backward).toBe(text);
	});

	it("keeps three pages and rejects late responses from a different revision", () => {
		const history = new RemoteHistory("session", "r1", [entry("large", "abcdef".repeat(60_000))]);
		const cache = new RemotePageCache();
		let page = history.page(0, "after");
		const pages: RemoteHistoryPage[] = [];
		while (true) {
			pages.push(page);
			cache.put(page, "after");
			expect(cache.bytes).toBeLessThanOrEqual(3 * REMOTE_PAGE_BYTES);
			if (!page.after) break;
			page = history.page(pages.length, "after", page.after);
		}
		expect(cache.pages).toEqual(pages.slice(-3));
		expect(() => cache.put({ ...pages[0], revision: "r2" }, "before")).toThrow("Stale history page");
		expect(cache.pages).toEqual(pages.slice(-3));
	});

	it("rejects stale and invalid cursors instead of serving a different transcript position", () => {
		const history = new RemoteHistory("session", "r", [entry("first", "🤖hello")]);
		expect(() => history.page(1, "after", { block: "gone", offset: 0 })).toThrow("no longer exists");
		expect(() => history.page(1, "after", { block: "first:0", offset: 1 })).toThrow("offset");
		expect(() => history.page(1, "after", { block: "first:0", offset: -1 })).toThrow("offset");
	});

	it("serves paged guests without sending the legacy full snapshot or durable entries", async () => {
		const { ctx, guest, frames } = await pagedHost();
		const welcome = frames.find(frame => frame.t === "welcome");
		expect(welcome?.t === "welcome" && welcome.history?.revision).toBe("r1");
		expect(frames.filter(frame => frame.t === "snapshot-chunk").flatMap(frame => frame.entries)).toEqual([]);
		guest.send({ t: "history-fetch", reqId: 1, direction: "before", revision: "r1" });
		await waitFor(() => frames.some(frame => frame.t === "history-page"), "page");
		const page = frames.find(frame => frame.t === "history-page");
		expect(page?.t === "history-page" && page.before).not.toBeNull();
		expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(REMOTE_PAGE_BYTES);
		ctx.sessionManager.onEntryAppended?.(entry("new", "new message"));
		await waitFor(() => frames.some(frame => frame.t === "history-changed"), "history change");
		expect(frames.some(frame => frame.t === "entry")).toBe(false);
	});

	it("includes the accumulating assistant reply in a bounded page without delivering cumulative event payloads", async () => {
		const { guest, frames, emit } = await pagedHost();
		const message = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "live response ".repeat(30_000) }],
			api: "openai-completions" as const,
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: 0,
		};
		emit({ type: "message_start", message });
		guest.send({ t: "history-fetch", reqId: 2, direction: "before" });
		await waitFor(() => frames.some(frame => frame.t === "history-page" && frame.reqId === 2), "stream page");
		const page = frames.find(frame => frame.t === "history-page" && frame.reqId === 2);
		expect(page?.t === "history-page" && page.fragments.at(-1)?.text).toEndWith("live response ");
		expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(REMOTE_PAGE_BYTES);
		expect(frames.some(frame => frame.t === "event" && frame.event.type === "message_start")).toBe(false);
		if (page?.t !== "history-page") throw new Error("Missing initial stream page");
		const updated = {
			...message,
			content: [{ type: "text" as const, text: `${message.content[0].text}more tokens` }],
		};
		emit({
			type: "message_update",
			message: updated,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "more tokens", partial: updated },
		});
		guest.send({ t: "history-fetch", reqId: 3, direction: "before", have: historyPageHash(page) });
		await waitFor(() => frames.some(frame => frame.t === "history-delta" && frame.reqId === 3), "stream delta");
		const delta = frames.find(frame => frame.t === "history-delta" && frame.reqId === 3);
		if (delta?.t !== "history-delta") throw new Error("Missing stream delta");
		expect(Buffer.byteLength(JSON.stringify(delta))).toBeLessThan(2048);
		expect(applyHistoryDelta(page, delta).fragments.at(-1)?.text).toEndWith("more tokens");
	});

	it("reconstructs a shifted Unicode tail exactly and refuses a delta for another cached page", () => {
		const text = "🤖漢字\n".repeat(30_000);
		const base = new RemoteHistory("session", "r1", [entry("large", text)]).page(1, "before");
		const next = new RemoteHistory("session", "r2", [entry("large", `${text}new suffix`)]).page(2, "before");
		const delta = encodeHistoryDelta(base, next);
		if (delta.t !== "history-delta") throw new Error("Expected a bounded suffix delta");
		expect(applyHistoryDelta(base, delta)).toEqual(next);
		expect(historyPageHash(applyHistoryDelta(base, delta))).toBe(historyPageHash(next));
		expect(Buffer.byteLength(JSON.stringify(delta))).toBeLessThan(2048);
		expect(() => applyHistoryDelta({ ...base, revision: "different" }, delta)).toThrow("cached page");
		expect(() =>
			applyHistoryDelta(base, { ...delta, fragments: [{ ...delta.fragments[0], reuse: { start: -1, end: 0 } }] }),
		).toThrow("reference");
		const rewritten = new RemoteHistory("session", "r3", [
			entry("large", "completely rewritten".repeat(30_000)),
		]).page(3, "before");
		expect(encodeHistoryDelta(base, rewritten).t).toBe("history-page");
	});

	it("deduplicates retried prompt IDs while the original submission is in flight", async () => {
		const { ctx, guest, frames } = await pagedHost(true);
		const submitted = Promise.withResolvers<boolean>();
		const prompt = spyOn(ctx.session, "promptCustomMessage").mockImplementation(() => submitted.promise);
		const id = crypto.randomUUID();
		guest.send({ t: "remote-prompt", id, sessionId: "s", text: "change one thing" });
		guest.send({ t: "remote-prompt", id, sessionId: "s", text: "change one thing" });
		await waitFor(
			() => frames.filter(frame => frame.t === "prompt-status" && frame.id === id).length >= 2,
			"prompt receipts",
		);
		expect(prompt).toHaveBeenCalledTimes(1);
		submitted.resolve(true);
		await waitFor(
			() => frames.some(frame => frame.t === "prompt-status" && frame.id === id && frame.status === "accepted"),
			"accepted prompt",
		);
		guest.send({ t: "remote-prompt", id, sessionId: "s", text: "different instruction" });
		await waitFor(
			() => frames.some(frame => frame.t === "prompt-status" && frame.id === id && frame.status === "rejected"),
			"conflicting prompt rejected",
		);
		expect(prompt).toHaveBeenCalledTimes(1);
	});

	it("numbers paged notifications with an epoch that bumps on structural transcript changes", async () => {
		const { ctx, guest, frames, emit } = await pagedHost(true);
		const message = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "epoch probe" }],
			api: "openai-completions" as const,
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: 0,
		};
		emit({ type: "message_start", message });
		await waitFor(
			() => frames.some(frame => frame.t === "history-changed" && frame.epoch === 1 && frame.seq === 1),
			"first numbered notification",
		);
		emit({ type: "message_end", message });
		await waitFor(
			() => frames.some(frame => frame.t === "history-changed" && frame.epoch === 1 && frame.seq === 2),
			"second notification advances the sequence",
		);
		// A compaction entry structurally rewrites the transcript: the epoch must
		// bump and the sequence restart, so guests resync instead of trusting
		// sequence continuity across the boundary.
		const appended = ctx.sessionManager.onEntryAppended;
		if (!appended) throw new Error("the host never tapped entry appends");
		appended({
			type: "compaction",
			id: "compaction-1",
			parentId: null,
			timestamp: "2026-11-17T00:00:00Z",
			summary: "compacted",
		} as never);
		emit({ type: "message_start", message });
		await waitFor(
			() => frames.some(frame => frame.t === "history-changed" && frame.epoch === 2 && frame.seq === 1),
			"epoch bumped and sequence restarted after compaction",
		);
		const notifications = frames.filter(frame => frame.t === "history-changed");
		for (const frame of notifications) {
			expect(frame.epoch).toBeGreaterThanOrEqual(1);
			expect(frame.seq).toBeGreaterThanOrEqual(1);
		}
	});

	it("rejects a stale capture-control retry that predates an epoch boundary", async () => {
		const { ctx, guest, frames } = await pagedHost(true);
		const appended = ctx.sessionManager.onEntryAppended;
		if (!appended) throw new Error("the host never tapped entry appends");
		// Bump the epoch before the guest ever starts a capture: a control whose
		// epoch predates the boundary must be refused, not silently re-created.
		appended({
			type: "compaction",
			id: "c",
			parentId: null,
			timestamp: "2026-11-17T00:00:00Z",
			summary: "x",
		} as never);
		const staleEpochId = crypto.randomUUID();
		guest.send({ t: "capture-control", id: staleEpochId, action: "start", epoch: 1 });
		await waitFor(
			() => frames.some(frame => frame.t === "capture-status" && frame.id === staleEpochId && frame.error),
			"stale capture control rejected",
		);
		const current = frames.find(frame => frame.t === "capture-status" && frame.id === staleEpochId);
		expect(current?.t === "capture-status" && current.error).toContain("epoch");
		// A control carrying the CURRENT epoch starts normally.
		const liveId = crypto.randomUUID();
		guest.send({ t: "capture-control", id: liveId, action: "start", epoch: 2 });
		await waitFor(
			() => frames.some(frame => frame.t === "capture-status" && frame.id === liveId && frame.active),
			"current-epoch capture started",
		);
		guest.send({ t: "capture-control", id: liveId, action: "stop", epoch: 2 });
		await waitFor(
			() =>
				frames.some(frame => frame.t === "capture-status" && frame.id === liveId && !frame.active && !frame.error),
			"current-epoch capture stopped",
		);
	});

	it("accepts a retried prompt whose persisted content an extension rewrote, by original digest", async () => {
		installInMemoryRelay();
		const id = crypto.randomUUID();
		const originalText = "submit this exact prompt";
		const digest = new Bun.CryptoHasher("sha256").update(originalText).digest("hex");
		// The persisted record's content was rewritten by a host-side extension;
		// the digest of the original submission is what a retry must compare.
		const persistedEntry: SessionEntry = {
			type: "custom_message",
			id: "persisted-1",
			parentId: null,
			timestamp: "2026-11-17T00:00:00Z",
			customType: "collab-prompt",
			content: "EXTENSION-REWRITTEN CONTENT that no longer matches the guest text",
			display: true,
			details: { from: "paged", remoteRequestId: id, remotePromptDigest: digest },
			attribution: "user",
		};
		const snapshot = {
			header: { type: "session" as const, id: "s", timestamp: "2026-11-17", cwd: "/tmp" },
			entries: [persistedEntry],
		};
		const ctx = makeHostContext(snapshot, { notices: [], participantCounts: [] });
		ctx.sessionManager.getReplicationRevision = () => "r1";
		ctx.sessionManager.getBranch = () => [...snapshot.entries];
		let emit: (event: AgentSessionEvent) => void = () => {};
		const subscribe = ctx.session.subscribe.bind(ctx.session);
		spyOn(ctx.session, "subscribe").mockImplementation(listener => {
			emit = listener;
			return subscribe(listener);
		});
		const host = new CollabHost(ctx);
		cleanups.push(() => host.stop("test finished"));
		await host.start("ws://localhost:8788");
		const parsed = parseCollabLink(host.link);
		if ("error" in parsed) throw new Error(parsed.error);
		const guest = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
		cleanups.push(() => guest.close());
		const frames: CollabFrame[] = [];
		guest.onFrame = frame => frames.push(frame);
		guest.onOpen = () =>
			guest.send({
				t: "hello",
				proto: COLLAB_PROTO,
				name: "paged",
				pagedHistory: true,
				writeToken: parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined,
			});
		guest.connect();
		await waitFor(() => frames.some(frame => frame.t === "welcome"), "welcome");
		guest.send({ t: "remote-prompt", id, sessionId: "s", text: originalText });
		await waitFor(
			() => frames.some(frame => frame.t === "prompt-status" && frame.id === id && frame.status === "accepted"),
			"digest-matched retry accepted",
		);
		// A different original text must still be rejected: the digest is of the
		// first submission, not of whatever content is stored now.
		guest.send({ t: "remote-prompt", id, sessionId: "s", text: "different instruction" });
		await waitFor(
			() => frames.some(frame => frame.t === "prompt-status" && frame.id === id && frame.status === "rejected"),
			"conflicting retry rejected",
		);
	});

	it("does not execute read-only guest submissions", async () => {
		const { ctx, guest, frames } = await pagedHost();
		const prompt = spyOn(ctx.session, "promptCustomMessage");
		const id = crypto.randomUUID();
		guest.send({ t: "remote-prompt", id, sessionId: "s", text: "must not execute" });
		await waitFor(
			() => frames.some(frame => frame.t === "prompt-status" && frame.id === id && frame.status === "rejected"),
			"unauthorized prompt rejected",
		);
		expect(prompt).not.toHaveBeenCalled();
	});

	it("rejects a writable prompt for another session", async () => {
		const { ctx, guest, frames } = await pagedHost(true);
		const prompt = spyOn(ctx.session, "promptCustomMessage");
		const id = crypto.randomUUID();
		guest.send({ t: "remote-prompt", id, sessionId: "wrong-session", text: "must not execute" });
		await waitFor(
			() => frames.some(frame => frame.t === "prompt-status" && frame.id === id && frame.status === "rejected"),
			"wrong session rejected",
		);
		expect(prompt).not.toHaveBeenCalled();
	});

	it("starts one server recording for concurrent retries and acknowledges a durable stop", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-capture-control-"));
		cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
		const { guest, frames } = await pagedHost(true);
		const original = RemoteCapture.start;
		const gate = Promise.withResolvers<void>();
		const start = spyOn(RemoteCapture, "start").mockImplementation(async options => {
			await gate.promise;
			return original({ ...options, directory });
		});
		const id = crypto.randomUUID();
		guest.send({ t: "capture-control", id, action: "start" });
		guest.send({ t: "capture-control", id, action: "start" });
		await waitFor(() => start.mock.calls.length > 0, "capture starting");
		gate.resolve();
		await waitFor(
			() => frames.filter(frame => frame.t === "capture-status" && frame.id === id && frame.active).length === 2,
			"both start receipts",
		);
		expect(start).toHaveBeenCalledTimes(1);
		guest.send({ t: "capture-control", id, action: "mark", mark: "tunnel" });
		guest.send({ t: "capture-control", id, action: "stop" });
		await waitFor(
			() => frames.some(frame => frame.t === "capture-status" && frame.id === id && !frame.active && !frame.error),
			"server stopped",
		);
		const records = Bun.JSONL.parse(await Bun.file(path.join(directory, `${id}-server.jsonl`)).text()) as {
			event: string;
			mark?: string;
			values?: { sent?: boolean; bytes?: number };
		}[];
		expect(records.filter(record => record.event === "start")).toHaveLength(1);
		expect(records.find(record => record.event === "mark")?.mark).toBe("tunnel");
		expect(records.at(-1)?.event).toBe("stop");
		expect(
			records.some(
				record => record.event === "transport" && record.values?.sent === true && Number(record.values.bytes) > 0,
			),
		).toBe(true);
		expect(
			records.some(
				record => record.event === "transport" && record.values?.sent === false && Number(record.values.bytes) > 0,
			),
		).toBe(true);
	});

	it("pages pathological blocks without losing progress or exceeding the budget", () => {
		const cases = {
			// A single unbroken line whose table-like shape would demand huge parser context.
			hugeLine: "| a | b |".repeat(20_000),
			// A table whose header row alone would dominate a page if context were unbounded.
			hugeTableHeader: `| ${"x".repeat(40_000)} | b |\n|---|---|\n| 1 | 2 |`,
			// Huge astral-plane characters: cursor and fragment boundaries must stay surrogate-safe.
			hugeUnicode: "🤖🎉🚀".repeat(30_000),
		};
		for (const [name, text] of Object.entries(cases)) {
			const history = new RemoteHistory("session", "r1", [entry("block", text)]);
			for (const direction of ["after", "before"] as const) {
				let page = history.page(0, direction);
				let walked = 0;
				let guard = 0;
				while (guard++ < 100_000) {
					expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(REMOTE_PAGE_BYTES);
					const consumed = page.fragments.reduce((sum, fragment) => sum + fragment.text.length, 0);
					expect(consumed).toBeGreaterThan(0);
					walked += consumed;
					const cursor = direction === "after" ? page.after : page.before;
					if (!cursor) break;
					page = history.page(guard, direction, cursor);
				}
				expect(guard).toBeLessThan(100_000);
				expect(walked).toBe(text.length);
			}
		}
	});

	it("rejects fragments whose host-provided metadata is malformed at the receiving trust boundary", () => {
		const history = new RemoteHistory("session", "r1", [entry("m", "hello world")]);
		const page = history.page(0, "after");
		const cache = new RemotePageCache();
		cache.put(page, "after");
		const mutate = (fragment: Record<string, unknown>): RemoteHistoryPage => ({
			...page,
			fragments: [{ ...page.fragments[0]!, ...fragment } as (typeof page.fragments)[0]],
		});
		expect(() => cache.put(mutate({ prefix: 42 }), "after")).toThrow();
		expect(() => cache.put(mutate({ suffix: "x".repeat(REMOTE_PAGE_BYTES + 1) }), "after")).toThrow();
		expect(() => cache.put(mutate({ tool: { name: "bash", phase: "result" } }), "after")).toThrow();
		expect(() => cache.put(mutate({ tool: { callId: "c", name: "bash", phase: "other" } }), "after")).toThrow();
		expect(() =>
			cache.put(mutate({ tool: { callId: "c", name: "bash", phase: "call", args: "not-an-object" } }), "after"),
		).toThrow();
		// Well-formed metadata still passes.
		cache.put(mutate({ tool: { callId: "c", name: "bash", phase: "call", args: { x: 1 } } }), "after");
	});
});
