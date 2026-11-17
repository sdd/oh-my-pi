import { stripTerminalSequences } from "../utils";

export interface SourceRow {
	text: string;
	start: number;
	end: number;
}

/** Exact source range of one block token, derived structurally rather than by search. */
export interface TokenSpan {
	start: number;
	end: number;
}

/**
 * Bind painted text to source runs for tool fragments, where rendered rows are
 * direct transformations of the source text. Matching is sequential and
 * monotone: a row never maps before the previous row's match, so repeated
 * tokens cannot displace anchors across the fragment.
 */
export function mapSourceRows(source: string, lines: readonly string[], offset = 0): SourceRow[] {
	let cursor = 0;
	const rows = lines.map(text => {
		const words = stripTerminalSequences(text).match(/[\p{L}\p{N}_]+|[^\s]/gu) ?? [];
		let start: number | undefined;
		for (const word of words) {
			const at = source.indexOf(word, cursor);
			if (at < 0) continue;
			start ??= at;
			cursor = at + word.length;
		}
		return { text, start: offset + (start ?? cursor), end: offset + cursor };
	});
	for (let i = 0; i < rows.length; i++)
		rows[i].end = Math.max(rows[i].end, rows[i + 1]?.start ?? offset + source.length);
	return rows;
}

/**
 * Exact `[start, end)` of every block token in `source`. Markdown token raws
 * concatenate to the lexed text, so a sequential anchored scan resolves each
 * boundary without heuristic word matching; a raw that does not sit at the
 * cursor falls back to advancing by its length, keeping rows monotone.
 */
export function computeTokenSpans(source: string, tokens: readonly { raw?: string }[]): TokenSpan[] {
	const spans: TokenSpan[] = [];
	let cursor = 0;
	for (const token of tokens) {
		const raw = typeof token.raw === "string" ? token.raw : "";
		let start = cursor;
		if (raw.length > 0) {
			const at = source.indexOf(raw, cursor);
			if (at >= 0) {
				start = at;
				cursor = at + raw.length;
			} else {
				start = cursor;
				cursor = Math.min(source.length, cursor + raw.length);
			}
		}
		spans.push({ start, end: cursor });
	}
	return spans;
}

/**
 * Sequential spans of inline children inside a parent's raw. Child raws
 * concatenate to the parent raw, so the same anchored scan applies.
 */
export function computeChildSpans(
	parentRaw: string,
	children: readonly { raw?: string }[],
	parentStart: number,
): TokenSpan[] {
	const spans: TokenSpan[] = [];
	let cursor = 0;
	for (const child of children) {
		const raw = typeof child.raw === "string" ? child.raw : "";
		let start = cursor;
		if (raw.length > 0) {
			const at = parentRaw.indexOf(raw, cursor);
			if (at >= 0) {
				start = at;
				cursor = at + raw.length;
			} else {
				start = cursor;
				cursor = Math.min(parentRaw.length, cursor + raw.length);
			}
		}
		spans.push({ start: parentStart + start, end: parentStart + cursor });
	}
	return spans;
}

/**
 * Map a normalized offset back to the original text. Identity unless
 * normalization changed the length (tab expansion, orphan-fence repair).
 * Returns `undefined` when the texts are byte-identical.
 */
export function normalizationOffsetMap(original: string, normalized: string): Uint32Array | undefined {
	if (original === normalized) return undefined;
	const map = new Uint32Array(normalized.length + 1);
	let o = 0;
	for (let n = 0; n < normalized.length; n++) {
		if (o < original.length && original[o] === normalized[n]) {
			map[n] = o++;
			continue;
		}
		// The normalized text gained (tab expansion) or the original lost
		// (deleted line) characters here. Skip original characters until the
		// streams realign; unresolvable tails clamp to the original end.
		while (o < original.length && original[o] !== normalized[n]) o++;
		map[n] = Math.min(o, original.length);
		if (o < original.length && original[o] === normalized[n]) o++;
	}
	map[normalized.length] = Math.min(o, original.length);
	return map;
}

/**
 * Map a normalized offset back to original coordinates through a map from
 * {@link normalizationOffsetMap}; identity when the map is `undefined`.
 */
export function denormalizeOffset(map: Uint32Array | undefined, offset: number): number {
	if (map === undefined) return offset;
	return map[Math.min(offset, map.length - 1)]!;
}

/** Offsets of every source line start within `raw`, plus the final end offset. */
export function sourceLineOffsets(raw: string, base: number): number[] {
	const starts = [base];
	for (let i = 0; i < raw.length; i++) if (raw[i] === "\n") starts.push(base + i + 1);
	starts.push(base + raw.length);
	return starts;
}

/**
 * Distribute rendered rows across a token's source lines proportionally by row
 * index. Deterministic, monotone and confined to the token: rows never jump to
 * an unrelated block, which is the failure mode the previous word-search
 * heuristic exhibited. Every row covers at least one source line.
 */
export function proportionalRows(rows: readonly string[], span: TokenSpan, lineStarts: readonly number[]): SourceRow[] {
	const lineCount = Math.max(1, lineStarts.length - 1);
	return rows.map((text, r) => {
		const from = Math.min(lineCount - 1, Math.floor((r * lineCount) / rows.length));
		const to = Math.min(lineCount, Math.max(from + 1, Math.floor(((r + 1) * lineCount) / rows.length)));
		return { text, start: lineStarts[from]!, end: lineStarts[to]! };
	});
}

/** One rendered segment with its visible width and source range. */
export interface WidthSegment {
	start: number;
	end: number;
	width: number;
}

/**
 * Resolve the source range covered by a visible-width interval of a run of
 * segments. Position interpolation is linear inside a segment, so ranges stay
 * monotone and never leave the covered segments.
 */
export function sourceRangeForWidth(
	segments: readonly WidthSegment[],
	from: number,
	to: number,
): { start: number; end: number } {
	const at = (position: number): number => {
		let cursor = 0;
		for (const segment of segments) {
			if (position < cursor + segment.width || (segment.width === 0 && position <= cursor)) {
				const fraction = segment.width === 0 ? 0 : (position - cursor) / segment.width;
				return Math.round(segment.start + fraction * (segment.end - segment.start));
			}
			cursor += segment.width;
		}
		return segments.length > 0 ? segments.at(-1)!.end : 0;
	};
	const start = at(from);
	const end = at(to);
	return { start: Math.min(start, end), end: Math.max(start, end) };
}
