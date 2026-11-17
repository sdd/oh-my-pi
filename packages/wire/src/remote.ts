/** Semantic transcript pages: offsets are UTF-16 source positions, never terminal rows. */
export const REMOTE_PROTOCOL_VERSION = 1;
export const REMOTE_PAGE_BYTES = 64 * 1024;
export const REMOTE_CACHE_PAGES = 3;

export interface RemoteCursor {
	block: string;
	offset: number;
}

export interface RemoteFragment {
	id: string;
	entryId: string;
	kind: "user" | "assistant" | "thinking" | "tool" | "notice";
	label?: string;
	text: string;
	start: number;
	end: number;
	total: number;
	/** Bounded parser context preceding/following a fragment cut through Markdown. */
	prefix?: string;
	suffix?: string;
	tool?: {
		callId: string;
		name: string;
		args?: Record<string, unknown>;
		details?: unknown;
		isError?: boolean;
		phase: "call" | "result";
	};
}

export interface RemoteHistoryPage {
	t: "history-page";
	reqId: number;
	sessionId: string;
	revision: string;
	fragments: RemoteFragment[];
	before: RemoteCursor | null;
	after: RemoteCursor | null;
}

export interface RemoteHistoryRequest {
	t: "history-fetch";
	reqId: number;
	revision?: string;
	/** Hash of a retained page that may be reused by a bounded live-tail update. */
	have?: string;
	cursor?: RemoteCursor;
	direction: "before" | "after";
}

export interface RemoteHistoryDelta extends Omit<RemoteHistoryPage, "t" | "fragments"> {
	t: "history-delta";
	baseHash: string;
	fragments: (RemoteFragment & { reuse?: { start: number; end: number } })[];
}

export interface RemoteHistoryChanged {
	t: "history-changed";
	reqId?: number;
	sessionId: string;
	revision: string;
	/**
	 * Session-scoped epoch: bumped on room recreation and structural transcript
	 * changes (compaction, branch summary). A change of epoch means prior
	 * sequence numbers are meaningless and the guest must resync.
	 */
	epoch?: number;
	/** Monotonic within the epoch; a skipped or regressed value means lost notifications. */
	seq?: number;
}

export interface RemoteCaptureControl {
	t: "capture-control";
	id: string;
	action: "start" | "stop" | "mark";
	mark?: string;
	/** Guest's last seen notification epoch; a stale epoch rejects non-idempotent retries. */
	epoch?: number;
}

export interface RemoteCaptureStatus {
	t: "capture-status";
	id: string;
	active: boolean;
	bytes: number;
	dropped: number;
	error?: string;
}

export interface RemotePrompt {
	t: "remote-prompt";
	id: string;
	sessionId: string;
	text: string;
}

export interface RemotePromptStatus {
	t: "prompt-status";
	id: string;
	status: "pending" | "accepted" | "rejected";
}

export type RemoteHostFrame =
	| RemoteHistoryPage
	| RemoteHistoryDelta
	| RemoteHistoryChanged
	| RemoteCaptureStatus
	| RemotePromptStatus;
