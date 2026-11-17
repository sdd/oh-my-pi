import { REMOTE_CACHE_PAGES, REMOTE_PAGE_BYTES, type RemoteHistoryPage } from "@oh-my-pi/pi-wire/remote";
import { isRecord } from "@oh-my-pi/pi-utils";

export function assertRemoteHistoryPage(value: unknown): asserts value is RemoteHistoryPage {
	const cursor = (item: unknown): boolean =>
		item === null ||
		(isRecord(item) &&
			typeof item.block === "string" &&
			Number.isSafeInteger(item.offset) &&
			Number(item.offset) >= 0);
	/** Parser context and tool metadata are host-provided, not protocol-typed: validate shape and size. */
	const context = (item: unknown): boolean =>
		item === undefined || (typeof item === "string" && item.length <= REMOTE_PAGE_BYTES);
	const tool = (item: unknown): boolean => {
		if (!isRecord(item)) return false;
		return (
			typeof item.callId === "string" &&
			item.callId.length > 0 &&
			typeof item.name === "string" &&
			(item.args === undefined || isRecord(item.args)) &&
			(item.details === undefined || Buffer.byteLength(JSON.stringify(item.details)) <= REMOTE_PAGE_BYTES) &&
			(item.isError === undefined || typeof item.isError === "boolean") &&
			(item.phase === "call" || item.phase === "result")
		);
	};
	if (
		!isRecord(value) ||
		value.t !== "history-page" ||
		!Number.isSafeInteger(value.reqId) ||
		Number(value.reqId) < 0 ||
		typeof value.sessionId !== "string" ||
		typeof value.revision !== "string" ||
		!Array.isArray(value.fragments) ||
		!cursor(value.before) ||
		!cursor(value.after) ||
		Buffer.byteLength(JSON.stringify(value)) > REMOTE_PAGE_BYTES
	)
		throw new Error("Invalid or oversized remote history page");
	for (const fragment of value.fragments) {
		if (
			!isRecord(fragment) ||
			typeof fragment.id !== "string" ||
			typeof fragment.entryId !== "string" ||
			typeof fragment.text !== "string" ||
			!["user", "assistant", "thinking", "tool", "notice"].includes(String(fragment.kind)) ||
			(fragment.label !== undefined && typeof fragment.label !== "string") ||
			!context(fragment.prefix) ||
			!context(fragment.suffix) ||
			(fragment.tool !== undefined && !tool(fragment.tool)) ||
			!Number.isSafeInteger(fragment.start) ||
			!Number.isSafeInteger(fragment.end) ||
			!Number.isSafeInteger(fragment.total) ||
			Number(fragment.start) < 0 ||
			Number(fragment.end) < Number(fragment.start) ||
			Number(fragment.end) > Number(fragment.total) ||
			Number(fragment.end) - Number(fragment.start) !== fragment.text.length
		)
			throw new Error("Invalid remote history fragment");
	}
}

/** A display-only window; it never owns a SessionManager or modifies model context. */
export class RemotePageCache {
	#pages: RemoteHistoryPage[] = [];
	get pages(): readonly RemoteHistoryPage[] {
		return this.#pages;
	}
	get bytes(): number {
		return this.#pages.reduce((sum, page) => sum + Buffer.byteLength(JSON.stringify(page)), 0);
	}
	clear(): void {
		this.#pages = [];
	}
	put(page: RemoteHistoryPage, direction: "before" | "after"): void {
		assertRemoteHistoryPage(page);
		const current = this.#pages[0];
		if (current && (current.sessionId !== page.sessionId || current.revision !== page.revision))
			throw new Error("Stale history page");
		const duplicate = this.#pages.some(
			existing => JSON.stringify(existing.fragments) === JSON.stringify(page.fragments),
		);
		if (duplicate) return;
		if (direction === "before") {
			this.#pages.unshift(page);
			this.#pages.splice(REMOTE_CACHE_PAGES);
		} else {
			this.#pages.push(page);
			if (this.#pages.length > REMOTE_CACHE_PAGES) this.#pages.shift();
		}
	}
}
