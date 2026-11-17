import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import type { Token } from "@oh-my-pi/pi-utils/marked";
import { lexDocument } from "./markdown";

/**
 * Parser context is a display hint, never authoritative content: an oversized
 * piece is dropped entirely rather than allowed to consume the page budget or
 * arrive truncated into broken Markdown.
 */
const MAX_CONTEXT_CHARS = 2048;
/** One ancestor/containing item line kept for list nesting context. */
const MAX_LIST_LINE_CHARS = 160;
/** Shared windows: bounded lex structures reused across page fetches for unchanged blocks. */
const WINDOW_CACHE_MAX_CHARS = 8 * 1024 * 1024;

export interface MarkdownWindowContext {
	prefix?: string;
	suffix?: string;
}

/** The syntax surrounding a sparse window, without retaining the omitted document on the client. */
export class MarkdownWindow {
	readonly #source: string;
	readonly #tokens: Token[];
	constructor(source: string) {
		this.#source = source;
		this.#tokens = lexDocument(source);
	}

	context(start: number, end: number): MarkdownWindowContext {
		const atStart = this.#at(this.#tokens, 0, start, { prefix: "", suffix: "" });
		const atEnd = this.#at(this.#tokens, 0, end, { prefix: "", suffix: "" });
		return {
			prefix: boundedContext(atStart.prefix),
			suffix: boundedContext(atEnd.suffix),
		};
	}

	#at(tokens: readonly Token[], base: number, offset: number, outer: MarkdownWindowContext): MarkdownWindowContext {
		let cursor = base;
		for (const token of tokens) {
			const position = this.#source.indexOf(token.raw, cursor);
			const start = position < 0 ? cursor : position;
			const end = start + token.raw.length;
			cursor = end;
			if (offset <= start || offset >= end) continue;
			if (token.type === "code") {
				const fence = /^ {0,3}(`{3,}|~{3,})[^\n]*\n/.exec(token.raw);
				if (fence && offset >= start + fence[0].length) {
					return { prefix: outer.prefix + fence[0], suffix: `\n${fence[1]}\n` };
				}
			}
			if (token.type === "table") {
				const headerEnd = token.raw.indexOf("\n", token.raw.indexOf("\n") + 1) + 1;
				if (headerEnd > 0 && offset >= start + headerEnd) {
					return { prefix: outer.prefix + token.raw.slice(0, headerEnd), suffix: "" };
				}
			}
			if (token.type === "list") {
				const items = "items" in token && Array.isArray(token.items) ? token.items : [];
				let itemCursor = start;
				for (const item of items) {
					const at = this.#source.indexOf(item.raw, itemCursor);
					const itemStart = at < 0 ? itemCursor : at;
					const itemEnd = itemStart + item.raw.length;
					itemCursor = itemEnd;
					if (offset <= itemStart || offset >= itemEnd) continue;
					// A cut inside an item must inherit the enclosing items' markers,
					// or nested indentation renders as an indented code block.
					const ancestor = outer.prefix + firstLine(item.raw);
					if (offset === itemStart) {
						return this.#at(item.tokens ?? [], itemStart, offset, { prefix: ancestor, suffix: outer.suffix });
					}
					const preCut = this.#source.slice(itemStart, offset);
					const inner = firstLine(item.raw);
					const carried = preCut.length <= MAX_CONTEXT_CHARS - ancestor.length ? preCut : inner;
					return this.#at(item.tokens ?? [], itemStart, offset, {
						prefix: ancestor + carried,
						suffix: outer.suffix,
					});
				}
				continue;
			}
			if ("tokens" in token && Array.isArray(token.tokens) && token.tokens.length) {
				const children: Token[] = token.tokens;
				const first = token.raw.indexOf(children[0].raw);
				if (first < 0) continue;
				const nested = this.#at(children, start + first, offset, outer);
				if (["strong", "em", "del", "link", "codespan"].includes(token.type)) {
					const last = children.at(-1)!;
					const lastEnd = token.raw.lastIndexOf(last.raw) + last.raw.length;
					return {
						prefix: token.raw.slice(0, first) + nested.prefix,
						suffix: nested.suffix + token.raw.slice(lastEnd),
					};
				}
				return nested;
			}
			if (token.type === "codespan") return { prefix: outer.prefix + "`", suffix: "`" };
		}
		return outer;
	}
}

function boundedContext(text: string | undefined): string | undefined {
	if (text === undefined || text.length === 0 || text.length > MAX_CONTEXT_CHARS) return undefined;
	return text;
}

/** The marker/indentation line that introduces a list item, bounded for context use. */
function firstLine(raw: string): string {
	const newline = raw.indexOf("\n");
	const line = newline < 0 ? raw : raw.slice(0, newline + 1);
	return line.length > MAX_LIST_LINE_CHARS ? "" : line;
}

const windowCache = new LRUCache<string, MarkdownWindow>({
	max: 64,
	maxSize: WINDOW_CACHE_MAX_CHARS,
	maxEntrySize: 1024 * 1024,
	sizeCalculation: (_window, text) => text.length + 64,
});

/**
 * A window cache shared by history serving: blocks are re-lexed only when their
 * text is first seen or evicted, never once per page fetch or revision bump.
 */
export function sharedMarkdownWindow(text: string): MarkdownWindow {
	const cached = windowCache.get(text);
	if (cached) return cached;
	const created = new MarkdownWindow(text);
	windowCache.set(text, created);
	return created;
}
