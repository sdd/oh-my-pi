import { afterEach, expect, it, spyOn, vi } from "bun:test";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";
import { runPagedGuest } from "../../src/remote/guest";
import { CollabHost } from "../../src/collab/host";
import { installInMemoryRelay, uninstallInMemoryRelay, type FakeWebSocket } from "./helpers/in-memory-relay";
import { makeHostContext, waitFor, type Snapshot } from "./helpers/throttled-host";
import { RemoteStateStorage } from "../../src/remote/saved-state";
import { getConfigRootDir } from "@oh-my-pi/pi-utils/dirs";
import * as path from "node:path";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	uninstallInMemoryRelay();
	vi.restoreAllMocks();
});

it("returns pending text to the draft instead of replaying it into a different session", async () => {
	installInMemoryRelay();
	const snapshot: Snapshot = {
		header: { type: "session", id: "new-session", timestamp: "2026-11-17", cwd: "/tmp" },
		entries: [],
	};
	const ctx = makeHostContext(snapshot, { notices: [], participantCounts: [] });
	ctx.sessionManager.getReplicationRevision = () => "new-revision";
	ctx.sessionManager.getBranch = () => [];
	const prompt = spyOn(ctx.session, "promptCustomMessage");
	const host = new CollabHost(ctx);
	cleanups.push(() => host.stop("test done"));
	await host.start("ws://localhost:8788");
	const storage = new RemoteStateStorage(path.join(getConfigRootDir(), "remote", "guests"), host.link);
	await storage.write({
		version: 1,
		sessionId: "old-session",
		draft: "",
		pages: [],
		prompts: [
			{
				t: "remote-prompt",
				id: crypto.randomUUID(),
				sessionId: "old-session",
				text: "instruction for previous session",
			},
		],
	});
	const terminal = new VirtualTerminal(100, 24);
	const running = runPagedGuest(host.link, terminal);
	void running.catch(() => {});
	cleanups.push(async () => {
		terminal.sendInput("\x03");
		await running;
	});
	await waitFor(
		() => terminal.getViewport().join("\n").includes("instruction for previous session"),
		"unsent previous-session draft",
	);
	expect(prompt).not.toHaveBeenCalled();
	terminal.sendInput("\x03");
	await running;
	expect(await storage.load()).toMatchObject({
		sessionId: "new-session",
		draft: "instruction for previous session",
		prompts: [],
	});
});

it("renders bounded recent history, submits online, and retains cached text and an unsent draft offline through resize", async () => {
	const relay = installInMemoryRelay();
	let guestSocket: FakeWebSocket | undefined;
	const connect = relay.connect.bind(relay);
	spyOn(relay, "connect").mockImplementation(socket => {
		connect(socket);
		if (socket.role === "guest") guestSocket = socket;
	});
	const snapshot: Snapshot = {
		header: { type: "session", id: "paged-vt", timestamp: "2026-11-17", cwd: "/tmp" },
		entries: [
			{
				type: "message",
				id: "long",
				parentId: null,
				timestamp: "2026-11-17",
				message: {
					role: "user",
					content: `UNCACHED PREFIX\n${"Earlier message.\n".repeat(20_000)}\nVISIBLE SUFFIX`,
					timestamp: 0,
				},
			},
		],
	};
	const ctx = makeHostContext(snapshot, { notices: [], participantCounts: [] });
	let revision = "r1";
	ctx.sessionManager.getReplicationRevision = () => revision;
	ctx.sessionManager.getBranch = () => [...snapshot.entries];
	const prompt = spyOn(ctx.session, "promptCustomMessage").mockResolvedValue(true);
	const host = new CollabHost(ctx);
	cleanups.push(() => host.stop("test done"));
	await host.start("ws://localhost:8788");
	const terminal = new VirtualTerminal(100, 24);
	let running = runPagedGuest(host.link, terminal);
	void running.catch(() => {});
	cleanups.push(async () => {
		terminal.sendInput("\x03");
		await running;
	});
	const screen = (): string => terminal.getViewport().join("\n");
	await waitFor(() => screen().includes("VISIBLE SUFFIX"), "paged guest renders recent suffix");
	expect(terminal.getScrollBuffer().join("\n")).not.toContain("UNCACHED PREFIX");
	const responseBytes: number[] = [];
	const forward = relay.forward.bind(relay);
	spyOn(relay, "forward").mockImplementation((sender, bytes) => {
		if (sender.role === "host") responseBytes.push(bytes.byteLength);
		forward(sender, bytes);
	});
	const entry = snapshot.entries[0];
	if (entry.type !== "message" || entry.message.role !== "user") throw new Error("Expected user entry");
	entry.message.content += "\nLIVE UPDATE";
	revision = "r2";
	ctx.sessionManager.onEntryAppended?.(entry);
	await waitFor(() => screen().includes("LIVE UPDATE"), "native guest applies the verified page delta");
	expect(Math.max(...responseBytes)).toBeLessThan(2048);
	terminal.sendInput("\x1b[200~change one thing\x1b[201~");
	terminal.sendInput("\r");
	await waitFor(() => prompt.mock.calls.length === 1, "online prompt");
	expect(prompt.mock.calls[0][0].content).toBe("change one thing");
	guestSocket!.closeFatal();
	await waitFor(() => screen().includes("Reconnecting"), "offline status");
	terminal.sendInput("\x1b[200~offline draft\x1b[201~");
	terminal.sendInput("\r");
	terminal.sendInput("\x1b[1;5F");
	terminal.resize(65, 20);
	await waitFor(
		() => screen().includes("offline draft") && screen().includes("VISIBLE SUFFIX"),
		"offline cache and draft after resize",
	);
	expect(prompt).toHaveBeenCalledTimes(1);
	terminal.sendInput("\x03");
	await running;
	const previousSocket = guestSocket;
	running = runPagedGuest(host.link, terminal);
	void running.catch(() => {});
	await waitFor(
		() =>
			guestSocket !== previousSocket &&
			screen().includes("queue") &&
			screen().includes("offline draft") &&
			screen().includes("VISIBLE SUFFIX"),
		"restart restores draft and bounded cache",
	);
	expect(prompt).toHaveBeenCalledTimes(1);
	await host.stop("completed session");
	await waitFor(() => screen().includes("Session ended"), "explicit goodbye ends reconnects", 1000).catch(error => {
		throw new Error(`${String(error)}\n${screen()}`);
	});
	expect(screen()).toContain("offline draft");
});
