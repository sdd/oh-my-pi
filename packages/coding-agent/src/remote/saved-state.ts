import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, isRecord } from "@oh-my-pi/pi-utils";
import type { RemoteHistoryPage, RemotePrompt } from "@oh-my-pi/pi-wire/remote";
import { writeFileAtomically } from "../utils/atomic-file";
import { assertRemoteHistoryPage } from "./page-cache";

export interface SavedRemoteState {
	version: 1;
	draft: string;
	sessionId?: string;
	pages: RemoteHistoryPage[];
	prompts: RemotePrompt[];
	/**
	 * Deployment endpoint (relay base URL) observed when last connected:
	 * endpoint identity persists independently of invitation URLs and loopback
	 * ports, so reattachment can prefer the known endpoint.
	 */
	endpoint?: string;
}

/** The room secret is hashed into the filename, never persisted in the saved state. */
export class RemoteStateStorage {
	readonly #file: string;
	#chain: Promise<void> = Promise.resolve();
	constructor(directory: string, link: string) {
		this.#file = path.join(directory, `${new Bun.CryptoHasher("sha256").update(link).digest("hex")}.json`);
	}

	async load(): Promise<SavedRemoteState | undefined> {
		try {
			const file = Bun.file(this.#file);
			if (file.size > 2 * 1024 * 1024) throw new Error("Saved remote state exceeds 2 MiB");
			const value: unknown = await file.json();
			if (
				!isRecord(value) ||
				value.version !== 1 ||
				typeof value.draft !== "string" ||
				!Array.isArray(value.pages) ||
				value.pages.length > 3 ||
				!Array.isArray(value.prompts) ||
				value.prompts.length > 16
			)
				throw new Error("Invalid saved remote state");
			if (value.sessionId !== undefined && typeof value.sessionId !== "string")
				throw new Error("Invalid saved remote session");
			if (value.endpoint !== undefined && (typeof value.endpoint !== "string" || value.endpoint.length > 2048))
				throw new Error("Invalid saved remote endpoint");
			const pages: RemoteHistoryPage[] = [];
			for (const page of value.pages) {
				assertRemoteHistoryPage(page);
				if (page.sessionId !== value.sessionId || (pages.length && page.revision !== pages[0].revision))
					throw new Error("Inconsistent saved history revision");
				pages.push(page);
			}
			const prompts: RemotePrompt[] = [];
			for (const prompt of value.prompts) {
				if (
					!isRecord(prompt) ||
					prompt.t !== "remote-prompt" ||
					typeof prompt.id !== "string" ||
					!/^[a-f0-9-]{36}$/i.test(prompt.id) ||
					typeof prompt.sessionId !== "string" ||
					typeof prompt.text !== "string" ||
					Buffer.byteLength(prompt.text) > 64 * 1024
				)
					throw new Error("Invalid saved prompt");
				if (prompts.some(previous => previous.id === prompt.id)) throw new Error("Duplicate saved prompt ID");
				prompts.push({ t: "remote-prompt", id: prompt.id, sessionId: prompt.sessionId, text: prompt.text });
			}
			return {
				version: 1,
				draft: value.draft,
				sessionId: value.sessionId,
				endpoint: value.endpoint,
				pages,
				prompts,
			};
		} catch (error) {
			if (isEnoent(error)) return undefined;
			throw error;
		}
	}

	write(state: SavedRemoteState): Promise<void> {
		const source = `${JSON.stringify(state)}\n`;
		if (Buffer.byteLength(source) > 2 * 1024 * 1024)
			return Promise.reject(new Error("Remote draft and pending prompts exceed 2 MiB"));
		this.#chain = this.#chain
			.catch(() => {})
			.then(async () => {
				await fs.mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
				await writeFileAtomically(this.#file, source);
			});
		return this.#chain;
	}
}
