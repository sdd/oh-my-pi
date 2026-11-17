import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { stripTerminalSequences } from "@oh-my-pi/pi-tui/utils";
import type { RemoteHistoryPage } from "@oh-my-pi/pi-wire/remote";
import { RemoteStateStorage, type SavedRemoteState } from "../../src/remote/saved-state";
import { RemoteViewport } from "../../src/remote/viewport";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

function page(start: number, end: number): RemoteHistoryPage {
	const text = Array.from({ length: 30 }, (_, i) => `line ${i.toString().padStart(2, "0")}\n`).join("");
	return {
		t: "history-page",
		reqId: 1,
		sessionId: "session",
		revision: "r1",
		fragments: [
			{
				id: "message",
				entryId: "entry",
				kind: "assistant",
				text: text.slice(start, end),
				start,
				end,
				total: text.length,
			},
		],
		before: start ? { block: "message", offset: start } : null,
		after: end < text.length ? { block: "message", offset: end } : null,
	};
}

describe("remote guest state", () => {
	it("restores the latest draft and pending prompt from a private file without storing the room secret", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-guest-state-"));
		directories.push(directory);
		const link = "https://example.test/#private-room-secret";
		const storage = new RemoteStateStorage(directory, link);
		const state: SavedRemoteState = {
			version: 1,
			draft: "first",
			sessionId: "session",
			pages: [page(0, 80)],
			prompts: [{ t: "remote-prompt", id: crypto.randomUUID(), sessionId: "session", text: "apply the change" }],
		};
		await Promise.all([storage.write(state), storage.write({ ...state, draft: "latest" })]);
		expect(await new RemoteStateStorage(directory, link).load()).toEqual({ ...state, draft: "latest" });
		const [file] = await fs.readdir(directory);
		expect(file).not.toContain("private-room-secret");
		expect(await Bun.file(path.join(directory, file)).text()).not.toContain("private-room-secret");
		expect((await fs.stat(path.join(directory, file))).mode & 0o777).toBe(0o600);
	});

	it("rejects corrupt history offsets and mixed session revisions on disk", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-guest-invalid-"));
		directories.push(directory);
		const storage = new RemoteStateStorage(directory, "link");
		const state: SavedRemoteState = {
			version: 1,
			draft: "keep me",
			sessionId: "session",
			pages: [page(0, 80)],
			prompts: [],
		};
		await storage.write(state);
		const [file] = await fs.readdir(directory);
		const corrupted = page(0, 80);
		corrupted.fragments[0].end = 81;
		await Bun.write(path.join(directory, file), JSON.stringify({ ...state, pages: [corrupted] }));
		await expect(storage.load()).rejects.toThrow("fragment");
		await Bun.write(
			path.join(directory, file),
			JSON.stringify({ ...state, pages: [page(0, 80), { ...page(80, 160), revision: "r2" }] }),
		);
		await expect(storage.load()).rejects.toThrow("revision");
	});

	it("persists the deployment endpoint independently of the invitation URL", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-guest-endpoint-"));
		directories.push(directory);
		const link = "https://example.test/#another-room-secret";
		const storage = new RemoteStateStorage(directory, link);
		const state: SavedRemoteState = {
			version: 1,
			draft: "",
			sessionId: "session",
			endpoint: "wss://relay.example/ws",
			pages: [page(0, 80)],
			prompts: [],
		};
		await storage.write(state);
		expect(await storage.load()).toMatchObject({ endpoint: "wss://relay.example/ws" });
		const [file] = await fs.readdir(directory);
		const stored = await Bun.file(path.join(directory, file)).text();
		// The endpoint survives; the invitation secret never does.
		expect(stored).toContain("wss://relay.example/ws");
		expect(stored).not.toContain("another-room-secret");
		// An oversized or non-string endpoint is rejected, not trusted.
		await Bun.write(path.join(directory, file), JSON.stringify({ ...state, endpoint: 42 }));
		await expect(storage.load()).rejects.toThrow("endpoint");
	});

	it("keeps the same visible line when preceding history arrives and shows loading and offline boundaries", () => {
		const viewport = new RemoteViewport(() => 8);
		viewport.cache.put(page(80, 160), "after");
		viewport.connected = true;
		viewport.render(60);
		viewport.scroll(-10_000);
		viewport.scroll(1);
		const before = viewport.render(60).map(stripTerminalSequences);
		viewport.loading = "before";
		expect(viewport.render(60)[0]).toContain("Loading earlier");
		viewport.cache.put(page(0, 80), "before");
		viewport.loading = undefined;
		const after = viewport.render(60).map(stripTerminalSequences);
		expect(after.slice(1, -1)).toEqual(before.slice(1, -1));
		viewport.connected = false;
		let requests = 0;
		viewport.request = () => {
			requests++;
		};
		viewport.scroll(10_000);
		expect(viewport.render(60).at(-1)).toContain("unavailable offline");
		expect(requests).toBe(0);
		viewport.live();
		expect(viewport.render(30).slice(1, -1).join("\n")).toContain("line 19");
	});
});
