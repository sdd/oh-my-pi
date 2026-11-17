import { REMOTE_PAGE_BYTES, type RemoteHistoryPage, type RemoteHistoryDelta } from "@oh-my-pi/pi-wire/remote";
import { assertRemoteHistoryPage } from "./page-cache";
import { stableStringifyJson } from "@oh-my-pi/pi-utils/json";

export function historyPageHash(page: RemoteHistoryPage): string {
	return new Bun.CryptoHasher("sha256").update(stableStringifyJson(page)).digest("hex");
}

/** Reference verified overlapping text, falling back to a full page when the delta costs more. */
export function encodeHistoryDelta(
	base: RemoteHistoryPage,
	page: RemoteHistoryPage,
): RemoteHistoryDelta | RemoteHistoryPage {
	if (base.sessionId !== page.sessionId) return page;
	const delta: RemoteHistoryDelta = {
		...page,
		t: "history-delta",
		baseHash: historyPageHash(base),
		fragments: page.fragments.map(fragment => {
			const old = base.fragments.find(previous => previous.id === fragment.id);
			if (!old || fragment.start < old.start || fragment.start >= old.end) return fragment;
			const end = Math.min(old.end, fragment.end);
			const length = end - fragment.start;
			if (fragment.text.slice(0, length) !== old.text.slice(fragment.start - old.start, end - old.start))
				return fragment;
			return { ...fragment, text: fragment.text.slice(length), reuse: { start: fragment.start, end } };
		}),
	};
	return Buffer.byteLength(JSON.stringify(delta)) < Buffer.byteLength(JSON.stringify(page)) ? delta : page;
}

export function applyHistoryDelta(base: RemoteHistoryPage, delta: RemoteHistoryDelta): RemoteHistoryPage {
	if (
		Buffer.byteLength(JSON.stringify(delta)) > REMOTE_PAGE_BYTES ||
		delta.baseHash !== historyPageHash(base) ||
		delta.sessionId !== base.sessionId
	)
		throw new Error("History delta does not match the cached page");
	const page: RemoteHistoryPage = {
		t: "history-page",
		reqId: delta.reqId,
		sessionId: delta.sessionId,
		revision: delta.revision,
		before: delta.before,
		after: delta.after,
		fragments: delta.fragments.map(fragment => {
			const { reuse, ...result } = fragment;
			if (!reuse) return result;
			const previous = base.fragments.find(old => old.id === fragment.id);
			if (
				!previous ||
				!Number.isSafeInteger(reuse.start) ||
				!Number.isSafeInteger(reuse.end) ||
				reuse.start !== fragment.start ||
				reuse.start < previous.start ||
				reuse.end > previous.end ||
				reuse.end < reuse.start
			)
				throw new Error("Invalid history delta reference");
			return {
				...result,
				text: previous.text.slice(reuse.start - previous.start, reuse.end - previous.start) + result.text,
			};
		}),
	};
	assertRemoteHistoryPage(page);
	return page;
}
