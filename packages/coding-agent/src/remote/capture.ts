import * as fs from "node:fs/promises";
import * as path from "node:path";

export type CaptureEvent =
	| "start"
	| "stop"
	| "sample"
	| "connected"
	| "disconnected"
	| "request"
	| "response"
	| "transport"
	| "mark"
	| "location"
	| "location-unavailable"
	| "dropped";

export interface LocationFix {
	source: "macos" | "phone";
	timestamp: number;
	latitude: number;
	longitude: number;
	accuracyM?: number;
}

export interface CaptureRecord {
	version: 1;
	captureId: string;
	role: "client" | "server";
	event: CaptureEvent;
	timestamp: number;
	monotonicMs: number;
	values?: Record<string, number | boolean>;
	mark?: string;
	location?: LocationFix;
}

export interface CaptureOptions {
	id: string;
	role: "client" | "server";
	directory: string;
	maxBytes?: number;
	durationMs?: number;
}

/** Private local recording with bounded pending writes; recording never backpressures the agent. */
export class RemoteCapture {
	readonly id: string;
	readonly file: string;
	readonly #handle: fs.FileHandle;
	readonly #limit: number;
	readonly #timer: Timer;
	readonly #sampleTimer: Timer;
	readonly #role: "client" | "server";
	#bytes = 0;
	#pending = 0;
	#dropped = 0;
	#closed = false;
	#chain: Promise<void> = Promise.resolve();
	#error: string | undefined;
	#stopping: Promise<void> | undefined;
	#onStop = new Set<() => void>();

	static async start(options: CaptureOptions): Promise<RemoteCapture> {
		if (!/^[a-f0-9-]{36}$/i.test(options.id)) throw new Error("Invalid capture ID");
		if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 256))
			throw new Error("Invalid capture byte limit");
		if (options.durationMs !== undefined && (!Number.isFinite(options.durationMs) || options.durationMs <= 0))
			throw new Error("Invalid capture duration");
		await fs.mkdir(options.directory, { recursive: true, mode: 0o700 });
		const file = path.join(options.directory, `${options.id}-${options.role}.jsonl`);
		const handle = await fs.open(file, "wx", 0o600);
		const capture = new RemoteCapture(options, file, handle);
		capture.record("start");
		return capture;
	}

	constructor(options: CaptureOptions, file: string, handle: fs.FileHandle) {
		this.id = options.id;
		this.file = file;
		this.#handle = handle;
		this.#role = options.role;
		this.#limit = options.maxBytes ?? 256 * 1024 * 1024;
		this.#timer = setTimeout(
			() => {
				void this.stop();
			},
			options.durationMs ?? 4 * 60 * 60 * 1000,
		);
		this.#timer.unref();
		this.#sampleTimer = setInterval(() => {
			const cpu = process.cpuUsage();
			this.record("sample", {
				rssBytes: process.memoryUsage().rss,
				cpuUserUs: cpu.user,
				cpuSystemUs: cpu.system,
				dropped: this.#dropped,
			});
		}, 1_000);
		this.#sampleTimer.unref();
	}

	get status(): { bytes: number; dropped: number; closed: boolean; error?: string } {
		return { bytes: this.#bytes, dropped: this.#dropped, closed: this.#closed, error: this.#error };
	}

	/** Register resources that must stop even when the size or duration limit ends capture. */
	onStop(callback: () => void): () => void {
		if (this.#closed) callback();
		else this.#onStop.add(callback);
		return () => {
			this.#onStop.delete(callback);
		};
	}

	record(event: CaptureEvent, values?: Record<string, number | boolean>, mark?: string, location?: LocationFix): void {
		if (this.#closed) return;
		if (this.#pending >= 256) {
			this.#dropped++;
			return;
		}
		const numeric = values
			? Object.fromEntries(
					Object.entries(values).filter(([, value]) => typeof value === "boolean" || Number.isFinite(value)),
				)
			: undefined;
		const record: CaptureRecord = {
			version: 1,
			captureId: this.id,
			role: this.#role,
			event,
			timestamp: Date.now(),
			monotonicMs: performance.now(),
			values: numeric,
			mark: mark?.slice(0, 256),
			location,
		};
		const line = `${JSON.stringify(record)}\n`;
		const size = Buffer.byteLength(line);
		if (this.#bytes + size > this.#limit) {
			this.#error = "Capture byte limit reached";
			if (event !== "stop") {
				this.#closed = true;
				void this.stop();
			}
			return;
		}
		this.#bytes += size;
		this.#pending++;
		this.#chain = this.#chain.then(async () => {
			try {
				await this.#handle.writeFile(line);
			} catch (error) {
				this.#error = String(error);
				this.#closed = true;
				void this.stop();
			} finally {
				this.#pending--;
			}
		});
	}

	stop(): Promise<void> {
		if (this.#stopping) return this.#stopping;
		if (!this.#closed) this.record("stop", { dropped: this.#dropped });
		this.#closed = true;
		clearTimeout(this.#timer);
		clearInterval(this.#sampleTimer);
		for (const callback of this.#onStop) {
			try {
				callback();
			} catch (error) {
				this.#error ??= String(error);
			}
		}
		this.#onStop.clear();
		this.#stopping = this.#chain
			.then(() => this.#handle.close())
			.catch(error => {
				this.#error ??= String(error);
			});
		return this.#stopping;
	}
}
