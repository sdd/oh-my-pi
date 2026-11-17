import {
	REMOTE_PAGE_BYTES,
	type RemoteCursor,
	type RemoteFragment,
	type RemoteHistoryPage,
} from "@oh-my-pi/pi-wire/remote";
import type { SessionEntry } from "../session/session-entries";
import { stringifyJson } from "@oh-my-pi/pi-utils/json";
import { replaceTabs, stripTerminalSequences } from "@oh-my-pi/pi-tui/utils";
import { sharedMarkdownWindow } from "@oh-my-pi/pi-tui/components/markdown-window";

interface HistoryBlock {
	id: string;
	entryId: string;
	kind: RemoteFragment["kind"];
	label?: string;
	text: string;
	tool?: RemoteFragment["tool"];
}

function blocksOf(entry: SessionEntry, calls: ReadonlyMap<string, RemoteFragment["tool"]>): HistoryBlock[] {
	const blocks: HistoryBlock[] = [];
	const add = (raw: string, kind: RemoteFragment["kind"], label?: string, tool?: RemoteFragment["tool"]): void => {
		const text = replaceTabs(stripTerminalSequences(raw)).replace(/\r\n?/g, "\n");
		if (text.length) blocks.push({ id: `${entry.id}:${blocks.length}`, entryId: entry.id, kind, label, text, tool });
	};
	if (entry.type === "compaction" || entry.type === "branch_summary") {
		add(entry.summary, "notice", entry.type === "compaction" ? "Compaction" : "Branch summary");
	} else if (entry.type === "custom_message") {
		if (!entry.display) return blocks;
		if (typeof entry.content === "string") add(entry.content, "user", entry.customType);
		else
			for (const content of entry.content) {
				if (content.type === "text") add(content.text, "user", entry.customType);
				else if (content.type === "image") add("[Image: open the host session to view]", "notice");
			}
	} else if (entry.type === "message") {
		const message = entry.message;
		if (!("content" in message)) return blocks;
		const kind = message.role === "user" ? "user" : message.role === "toolResult" ? "tool" : "assistant";
		const label = message.role === "toolResult" ? message.toolName : undefined;
		if (message.role === "toolResult") {
			const previous = calls.get(message.toolCallId);
			let details: unknown;
			try {
				if (Buffer.byteLength(stringifyJson(message.details) ?? "") <= 4096) details = message.details;
			} catch {}
			const tool: RemoteFragment["tool"] = {
				callId: message.toolCallId,
				name: message.toolName,
				args: previous?.args,
				details,
				isError: message.isError,
				phase: "result",
			};
			const textParts: string[] = [];
			for (const content of message.content) {
				if (content.type === "text") textParts.push(content.text);
				else if (content.type === "image") textParts.push("[Image: open the host session to view]");
			}
			let detailText: string;
			try {
				detailText = stringifyJson(message.details, 2) ?? "";
			} catch {
				detailText = "[Tool details cannot be serialized]";
			}
			add(textParts.join("\n") || detailText || "Tool completed", "tool", label, tool);
			return blocks;
		}
		if (typeof message.content === "string") add(message.content, kind, label);
		else if (Array.isArray(message.content)) {
			for (const content of message.content) {
				if (content.type === "text") add(content.text, kind, label);
				else if (content.type === "thinking") add(content.thinking, "thinking");
				else if (content.type === "toolCall") {
					try {
						add(
							stringifyJson(content.arguments, 2) ?? "[Tool arguments unavailable]",
							"tool",
							content.name,
							calls.get(content.id),
						);
					} catch {
						add("[Tool arguments cannot be serialized]", "notice", content.name);
					}
				} else if (content.type === "image") add("[Image: open the host session to view]", "notice");
			}
		}
	}
	return blocks;
}

function validOffset(text: string, offset: number): boolean {
	return (
		Number.isSafeInteger(offset) &&
		offset >= 0 &&
		offset <= text.length &&
		!(
			offset > 0 &&
			offset < text.length &&
			/[\uD800-\uDBFF]/u.test(text[offset - 1]) &&
			/[\uDC00-\uDFFF]/u.test(text[offset])
		)
	);
}

/** Host-owned index over one immutable transcript revision. */
export class RemoteHistory {
	readonly #blocks: HistoryBlock[];
	readonly #positions = new Map<string, number>();
	readonly sessionId: string;
	readonly revision: string;

	constructor(sessionId: string, revision: string, entries: readonly SessionEntry[]) {
		this.sessionId = sessionId;
		this.revision = revision;
		const calls = new Map<string, RemoteFragment["tool"]>();
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			for (const content of entry.message.content) {
				if (content.type !== "toolCall") continue;
				let args: Record<string, unknown> | undefined;
				try {
					if (Buffer.byteLength(stringifyJson(content.arguments) ?? "") <= 4096) args = content.arguments;
				} catch {}
				calls.set(content.id, { callId: content.id, name: content.name, args, phase: "call" });
			}
		}
		this.#blocks = entries.flatMap(entry => blocksOf(entry, calls));
		for (const [index, block] of this.#blocks.entries()) this.#positions.set(block.id, index);
	}

	page(
		reqId: number,
		direction: "before" | "after",
		cursor?: RemoteCursor,
		byteLimit = REMOTE_PAGE_BYTES,
	): RemoteHistoryPage {
		if (!Number.isSafeInteger(reqId) || reqId < 0) throw new Error("Invalid history request ID");
		if (!Number.isSafeInteger(byteLimit) || byteLimit < 1024 || byteLimit > REMOTE_PAGE_BYTES)
			throw new Error("Invalid history page budget");
		const page: RemoteHistoryPage = {
			t: "history-page",
			reqId,
			sessionId: this.sessionId,
			revision: this.revision,
			fragments: [],
			before: null,
			after: null,
		};
		let index = cursor ? this.#positions.get(cursor.block) : direction === "before" ? this.#blocks.length - 1 : 0;
		if (index === undefined) throw new Error("History cursor no longer exists");
		let offset = cursor?.offset ?? (direction === "before" ? (this.#blocks[index]?.text.length ?? 0) : 0);
		if (cursor && !validOffset(this.#blocks[index].text, offset)) throw new Error("Invalid history cursor offset");
		// Reserve envelope and cursor space before spending the rest on UTF-8 JSON fragments.
		let remaining = byteLimit - Buffer.byteLength(JSON.stringify(page)) - 512;
		while (index >= 0 && index < this.#blocks.length && remaining > 512) {
			const block = this.#blocks[index];
			if ((direction === "before" && offset === 0) || (direction === "after" && offset === block.text.length)) {
				index += direction === "before" ? -1 : 1;
				offset = direction === "before" ? (this.#blocks[index]?.text.length ?? 0) : 0;
				continue;
			}
			let low = 0;
			let high = direction === "before" ? offset : block.text.length - offset;
			const fragment = (length: number): RemoteFragment => {
				let start = direction === "before" ? offset - length : offset;
				let end = direction === "before" ? offset : offset + length;
				if (!validOffset(block.text, start)) start++;
				if (!validOffset(block.text, end)) end--;
				if (length > 1024) {
					if (direction === "before" && start > 0) {
						const newline = block.text.indexOf("\n", start);
						if (newline >= 0 && newline + 1 < end) start = newline + 1;
					} else if (direction === "after" && end < block.text.length) {
						const newline = block.text.lastIndexOf("\n", end - 1);
						if (newline > start) end = newline + 1;
					}
				}
				const context = block.kind === "tool" ? {} : sharedMarkdownWindow(block.text).context(start, end);
				return {
					id: block.id,
					entryId: block.entryId,
					kind: block.kind,
					label: block.label,
					text: block.text.slice(start, end),
					start,
					end,
					total: block.text.length,
					...context,
					tool: block.tool,
				};
			};
			while (low < high) {
				const mid = Math.ceil((low + high) / 2);
				if (Buffer.byteLength(JSON.stringify(fragment(mid))) + 1 <= remaining) low = mid;
				else high = mid - 1;
			}
			const next = fragment(low);
			// The binary search measured candidate sizes, but parser context can
			// push even the smallest candidate past what is left in the budget.
			// Context is a display hint: drop it before dropping the block.
			const candidate =
				Buffer.byteLength(JSON.stringify(next)) + 1 <= remaining
					? next
					: { ...next, prefix: undefined, suffix: undefined };
			if (Buffer.byteLength(JSON.stringify(candidate)) + 1 > remaining || candidate.start === candidate.end) break;
			if (direction === "before") page.fragments.unshift(candidate);
			else page.fragments.push(candidate);
			remaining -= Buffer.byteLength(JSON.stringify(candidate)) + 1;
			offset = direction === "before" ? candidate.start : candidate.end;
		}
		const first = page.fragments[0];
		if (!first && index >= 0 && index < this.#blocks.length)
			throw new Error("History block metadata exceeds page budget");
		const last = page.fragments.at(-1);
		if (first) {
			const position = this.#positions.get(first.id)!;
			page.before = first.start > 0 || position > 0 ? { block: first.id, offset: first.start } : null;
		}
		if (last) {
			const position = this.#positions.get(last.id)!;
			page.after =
				last.end < last.total || position < this.#blocks.length - 1 ? { block: last.id, offset: last.end } : null;
		}
		if (Buffer.byteLength(JSON.stringify(page)) > byteLimit) throw new Error("History metadata exceeds page budget");
		return page;
	}
}
