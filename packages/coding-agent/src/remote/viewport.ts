import type { RemoteCursor, RemoteFragment } from "@oh-my-pi/pi-wire/remote";
import { ScrollView } from "@oh-my-pi/pi-tui/components/scroll-view";
import { Markdown } from "@oh-my-pi/pi-tui/components/markdown";
import { getMarkdownTheme } from "@oh-my-pi/pi-tui/theme";
import type { Component } from "@oh-my-pi/pi-tui";
import { replaceTabs, stripTerminalSequences, truncateToWidth } from "@oh-my-pi/pi-tui/utils";
import { RemotePageCache } from "./page-cache";
import { ToolExecutionComponent, type ToolExecutionUi } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { mapSourceRows } from "@oh-my-pi/pi-tui/render/source-map";

export type HistoryBoundary = "available" | "loading" | "offline" | "failed" | "end";

export function historyBoundaryLabel(direction: "before" | "after", state: HistoryBoundary): string {
	const arrow = direction === "before" ? "↑" : "↓";
	const side = direction === "before" ? "Earlier" : "Later";
	if (state === "end") return `${arrow} ${direction === "before" ? "Start" : "End"} of conversation`;
	if (state === "loading") return `${arrow} Loading ${side.toLowerCase()} history…`;
	if (state === "offline") return `${arrow} ${side} history unavailable offline`;
	if (state === "failed") return `${arrow} History load failed · scroll to retry`;
	return `${arrow} ${side} history available`;
}

interface AnchoredRow {
	text: string;
	id: string;
	offset: number;
	end: number;
	header: boolean;
}

/** Bounded memo of per-fragment rendered rows: large blocks must not re-render every frame. */
const FRAGMENT_RENDER_CACHE_MAX = 48;

/** App-owned remote scrolling; the terminal never receives history to retain. */
export class RemoteViewport implements Component {
	readonly cache = new RemotePageCache();
	readonly #scroll = new ScrollView([], { height: 1, scrollbar: "never" });
	#rows: AnchoredRow[] = [];
	#anchor: { id: string; offset: number; header: boolean } | undefined;
	#follow = true;
	connected = false;
	loading: "before" | "after" | undefined;
	error: string | undefined;
	status = "Connecting…";
	request: (direction: "before" | "after", cursor: RemoteCursor) => void = () => {};
	readonly #height: () => number;
	readonly #ui: ToolExecutionUi;
	#renderCache = new Map<string, AnchoredRow[]>();

	constructor(
		height: () => number,
		ui: ToolExecutionUi = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} },
	) {
		this.#height = height;
		this.#ui = ui;
	}

	get followsLive(): boolean {
		return this.#follow;
	}
	live(): void {
		this.#follow = true;
		this.#anchor = undefined;
	}

	scroll(delta: number): void {
		this.#follow = false;
		const before = this.#scroll.getScrollOffset();
		this.#scroll.scroll(delta);
		const row = this.#rows[this.#scroll.getScrollOffset()];
		if (row) this.#anchor = { id: row.id, offset: row.offset, header: row.header };
		if (this.loading || !this.connected) return;
		const pages = this.cache.pages;
		const margin = Math.max(0, this.#height() - 2);
		if (delta < 0 && this.#scroll.getScrollOffset() <= margin && pages[0]?.before)
			this.request("before", pages[0].before);
		else if (
			delta > 0 &&
			this.#scroll.getScrollOffset() >= this.#scroll.getMaxScrollOffset() - margin &&
			pages.at(-1)?.after
		)
			this.request("after", pages.at(-1)!.after!);
		else if (before === this.#scroll.getScrollOffset() && delta > 0 && !pages.at(-1)?.after) this.#follow = true;
	}

	render(width: number): readonly string[] {
		const rows: AnchoredRow[] = [];
		const fragments: RemoteFragment[] = [];
		for (const page of this.cache.pages)
			for (const fragment of page.fragments) {
				const previous = fragments.at(-1);
				if (previous?.id === fragment.id && previous.end === fragment.start) {
					previous.text += fragment.text;
					previous.end = fragment.end;
					// The right parser context and metadata belong to the LAST fragment of
					// the run; only the prefix (left context) and start stay from the first.
					if (fragment.suffix !== undefined) previous.suffix = fragment.suffix;
					else delete previous.suffix;
					if (fragment.label !== undefined) previous.label = fragment.label;
					if (fragment.tool !== undefined) previous.tool = fragment.tool;
					previous.total = fragment.total;
				} else fragments.push({ ...fragment });
			}
		// A tool result supersedes its call card: rendering both leaves the call
		// card permanently pending. Calls stay visible only until their result
		// arrives in the cached pages.
		const results = new Set<string>();
		for (const fragment of fragments) if (fragment.tool?.phase === "result") results.add(fragment.tool.callId);
		// Rendered rows are memoized per merged fragment; a cache hit skips both
		// Markdown lexing and tool-card construction for unchanged text at this width.
		const cache = this.#renderCache;
		const cacheKeyBase = `${width}\u0000`;
		for (const fragment of fragments) {
			if (fragment.tool?.phase === "call" && results.has(fragment.tool.callId)) continue;
			const key = `${cacheKeyBase}${fragment.id}:${fragment.start}:${fragment.end}:${Bun.hash(fragment.text)}:${fragment.tool ? Bun.hash(JSON.stringify(fragment.tool)) : "-"}`;
			// Pending tool cards animate a spinner: never memoize their rows.
			const cacheable = !fragment.tool || fragment.tool.phase === "result";
			const cached = cache.get(key);
			if (cached) {
				cache.delete(key);
				cache.set(key, cached);
				rows.push(...cached);
				continue;
			}
			const rendered = this.#renderFragment(fragment, width, fragments);
			if (cacheable) {
				cache.set(key, rendered);
				while (cache.size > FRAGMENT_RENDER_CACHE_MAX) {
					cache.delete(cache.keys().next().value!);
				}
			}
			rows.push(...rendered);
		}
		this.#rows = rows;
		this.#scroll.setHeight(Math.max(0, this.#height() - 2));
		this.#scroll.setLines(rows.map(row => row.text));
		if (this.#follow) this.#scroll.scrollToBottom();
		else if (this.#anchor) {
			let index = rows.findIndex(
				row =>
					row.id === this.#anchor!.id &&
					row.header === this.#anchor!.header &&
					row.offset <= this.#anchor!.offset &&
					row.end > this.#anchor!.offset,
			);
			if (index < 0)
				index = rows.findIndex(
					row =>
						row.id === this.#anchor!.id &&
						row.header === this.#anchor!.header &&
						row.offset >= this.#anchor!.offset,
				);
			if (index < 0) index = rows.findIndex(row => row.id === this.#anchor!.id);
			if (index >= 0) this.#scroll.setScrollOffset(index);
		}
		const boundary = (direction: "before" | "after"): HistoryBoundary => {
			const cursor = direction === "before" ? this.cache.pages[0]?.before : this.cache.pages.at(-1)?.after;
			if (this.loading === direction) return "loading";
			if (!cursor) return "end";
			if (!this.connected) return "offline";
			return this.error ? "failed" : "available";
		};
		return [
			truncateToWidth(
				replaceTabs(
					stripTerminalSequences(`${historyBoundaryLabel("before", boundary("before"))} · ${this.status}`),
				),
				width,
			),
			...this.#scroll.render(width),
			truncateToWidth(historyBoundaryLabel("after", boundary("after")), width),
		];
	}

	#renderFragment(fragment: RemoteFragment, width: number, fragments: readonly RemoteFragment[]): AnchoredRow[] {
		const source = replaceTabs(stripTerminalSequences(fragment.text));
		if (fragment.tool) {
			const tool = new ToolExecutionComponent(
				fragment.tool.name,
				this.#toolArgs(fragment, fragments),
				{ showImages: true, transcriptPresenters: false },
				undefined,
				this.#ui,
				"",
				fragment.tool.callId,
			);
			try {
				tool.setExpanded(true);
				tool.setArgsComplete();
				if (fragment.tool.phase === "result")
					tool.updateResult({
						content: [{ type: "text", text: source }],
						details: fragment.tool.details,
						isError: fragment.tool.isError,
					});
				return mapSourceRows(source, tool.render(width), fragment.start).map(row => ({
					text: row.text,
					id: fragment.id,
					offset: row.start,
					end: row.end,
					header: false,
				}));
			} finally {
				tool.dispose();
			}
		}
		const prefix = fragment.prefix ?? "";
		const markdown = new Markdown(prefix + source + (fragment.suffix ?? ""), 0, 0, getMarkdownTheme());
		const lines = markdown
			.renderMapped(width)
			.filter(row => row.end > prefix.length && row.start < prefix.length + source.length);
		const label = fragment.label ? `${fragment.kind}: ${fragment.label}` : fragment.kind;
		return [
			{
				text: truncateToWidth(
					replaceTabs(stripTerminalSequences(`${label}${fragment.start ? " (continued)" : ""}`)),
					width,
				),
				id: fragment.id,
				offset: fragment.start,
				end: fragment.start,
				header: true,
			},
			...lines.map(row => ({
				text: row.text,
				id: fragment.id,
				offset: fragment.start + Math.max(0, row.start - prefix.length),
				end: fragment.start + Math.min(source.length, row.end - prefix.length),
				header: false,
			})),
		];
	}

	/**
	 * Tool arguments beyond the 4 KiB metadata budget arrive only as paged call
	 * text: recover them from the cached call fragment instead of hiding them.
	 */
	#toolArgs(fragment: RemoteFragment, fragments: readonly RemoteFragment[]): Record<string, unknown> | undefined {
		const tool = fragment.tool;
		if (!tool) return undefined;
		if (tool.args !== undefined) return tool.args;
		if (tool.phase === "call") return parseArgsText(fragment.text);
		if (tool.phase === "result") {
			const call = fragments.find(item => item.tool?.callId === tool.callId && item.tool?.phase === "call");
			if (call) return call.tool?.args ?? parseArgsText(call.text);
		}
		return undefined;
	}
}

/** Call blocks carry serialized arguments as their text; parse bounded text only. */
function parseArgsText(text: string): Record<string, unknown> | undefined {
	if (text.length === 0 || text.length > 262_144) return undefined;
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
			return parsed as Record<string, unknown>;
	} catch {
		return undefined;
	}
	return undefined;
}
