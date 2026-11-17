import { describe, expect, it } from "bun:test";
import type { RemoteFragment, RemoteHistoryPage } from "@oh-my-pi/pi-wire/remote";
import { stripTerminalSequences } from "@oh-my-pi/pi-tui/utils";
import { RemoteViewport } from "../../src/remote/viewport";

function fragment(
	overrides: Partial<RemoteFragment> & { id: string; text: string; start: number; end: number },
): RemoteFragment {
	return {
		entryId: "e1",
		entryIdOverride: undefined,
		kind: "assistant",
		total: overrides.total ?? overrides.end,
		...overrides,
	} as RemoteFragment;
}

function page(fragments: RemoteFragment[]): RemoteHistoryPage {
	return {
		t: "history-page",
		reqId: 0,
		sessionId: "s",
		revision: "r1",
		fragments,
		before: null,
		after: null,
	};
}

function viewportWith(fragments: RemoteFragment[], width = 80): { output: string[]; viewport: RemoteViewport } {
	const viewport = new RemoteViewport(() => 24);
	viewport.cache.put(page(fragments), "after");
	viewport.connected = true;
	const output = [...viewport.render(width)].map(line => stripTerminalSequences(line));
	return { output, viewport };
}

describe("paged viewport rendering", () => {
	it("joins contiguous fragments with the last fragment's parser context", () => {
		// An inline code span cut across two fragments: only the LAST fragment
		// carries the closing backtick as suffix. Retaining the first fragment's
		// (absent) suffix would leave a visible stray backtick in the rendered row.
		const first = fragment({
			id: "block:0",
			text: "code ",
			start: 0,
			end: 5,
			total: 8,
			prefix: "`",
		});
		const second = fragment({
			id: "block:0",
			text: "con",
			start: 5,
			end: 8,
			total: 8,
			suffix: "`",
		});
		const { output } = viewportWith([first, second]);
		const joined = output.join("\n");
		expect(joined).toContain("code con");
		expect(joined).not.toContain("`code");
	});

	it("supersedes a pending call card once its result is cached", () => {
		const call = fragment({
			id: "call:0",
			kind: "tool",
			label: "bash",
			text: '{"command":"echo merged"}',
			start: 0,
			end: 25,
			tool: { callId: "c1", name: "bash", phase: "call" },
		});
		const result = fragment({
			id: "result:0",
			kind: "tool",
			label: "bash",
			text: "merged output line",
			start: 0,
			end: 18,
			tool: { callId: "c1", name: "bash", phase: "result", args: { command: "echo merged" } },
		});
		const { output } = viewportWith([call, result]);
		const joined = output.join("\n");
		expect(joined).toContain("merged output line");
		// The call's own text (serialized arguments) must not render as a second card.
		expect(joined).not.toContain('"command":"echo merged"');
	});

	it("recovers oversized arguments from the cached call fragment's paged text", () => {
		const args = '{"path":"/huge/file/that/exceeded/the/metadata/budget.txt"}';
		const call = fragment({
			id: "call:1",
			kind: "tool",
			label: "read",
			text: args,
			start: 0,
			end: args.length,
			tool: { callId: "c2", name: "read", phase: "call" },
		});
		const result = fragment({
			id: "result:1",
			kind: "tool",
			label: "read",
			text: "file contents shown",
			start: 0,
			end: 19,
			tool: { callId: "c2", name: "read", phase: "result" },
		});
		const { output } = viewportWith([call, result]);
		const joined = output.join("\n");
		expect(joined).toContain("file contents shown");
		expect(joined).toContain("/huge/file/that/exceeded/the/metadata/budget.txt");
	});

	it("keeps a call card pending while no result fragment is cached", () => {
		const call = fragment({
			id: "call:2",
			kind: "tool",
			label: "bash",
			text: '{"command":"sleep 30"}',
			start: 0,
			end: 22,
			tool: { callId: "c3", name: "bash", args: { command: "sleep 30" }, phase: "call" },
		});
		const { output } = viewportWith([call]);
		expect(output.join("\n")).toContain("sleep 30");
	});
});
