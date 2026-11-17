import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import {
	type HostProfileRecord,
	deleteHostProfile,
	hostProfilePath,
	loadHostProfile,
	resolveHostBinding,
	saveHostProfile,
} from "../../src/collab/host-profile";

/**
 * Profile names are unique per test so the tests never collide with each other
 * or with real profiles in the user's config root; afterEach removes them.
 */
const usedProfiles: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const profile of usedProfiles.splice(0).reverse()) await deleteHostProfile(profile);
});

function uniqueProfile(): string {
	const profile = `test-${crypto.randomUUID().slice(0, 8)}`;
	usedProfiles.push(profile);
	return profile;
}

function record(profile: string, overrides: Partial<HostProfileRecord> = {}): HostProfileRecord {
	return {
		version: 1,
		profile,
		sessionId: "session-1",
		sessionFile: "/sessions/session-1.jsonl",
		relayUrl: "wss://relay.example",
		createdAt: "2026-11-17T00:00:00Z",
		lastStartedAt: "2026-11-17T00:00:00Z",
		...overrides,
	};
}

describe("host profile binding", () => {
	it("persists the binding with owner-only permissions before any client can connect", async () => {
		const profile = uniqueProfile();
		await saveHostProfile(record(profile));
		const stored = await Bun.file(hostProfilePath(profile)).json();
		expect(stored).toMatchObject({ version: 1, sessionId: "session-1", sessionFile: "/sessions/session-1.jsonl" });
		const mode = (await fs.stat(hostProfilePath(profile))).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("round-trips through load and refuses to silently adopt a different session", async () => {
		const profile = uniqueProfile();
		await saveHostProfile(record(profile));
		const loaded = await loadHostProfile(profile);
		expect(loaded?.sessionId).toBe("session-1");
		// Same file resolves fine; a different file is a hard refusal.
		const same = await resolveHostBinding(profile, "/sessions/session-1.jsonl", async arg => arg);
		expect(same.sessionArg).toBe("/sessions/session-1.jsonl");
		await expect(
			resolveHostBinding(profile, "/sessions/other.jsonl", async arg => arg).then(
				() => "resolved",
				error => String(error),
			),
		).resolves.toContain("refusing to bind");
	});

	it("keeps the stored binding when the restart passes no --session", async () => {
		const profile = uniqueProfile();
		await saveHostProfile(record(profile));
		const resolved = await resolveHostBinding(profile, undefined, async () => {
			throw new Error("resolver must not run for the stored binding");
		});
		expect(resolved.sessionArg).toBe("/sessions/session-1.jsonl");
		expect(resolved.existing?.createdAt).toBe("2026-11-17T00:00:00Z");
	});

	it("refuses to start a profile that has no binding and no explicit session", async () => {
		const profile = uniqueProfile();
		await expect(
			resolveHostBinding(profile, undefined, async arg => arg).then(
				() => "resolved",
				error => String(error),
			),
		).resolves.toContain("no binding yet");
		// A first run with an explicit session binds it and persists nothing itself.
		const bound = await resolveHostBinding(profile, "/sessions/new.jsonl", async arg => arg);
		expect(bound.sessionArg).toBe("/sessions/new.jsonl");
		await expect(loadHostProfile(profile)).resolves.toBeUndefined();
	});

	it("rejects invalid profile names and reports a corrupt record instead of guessing", async () => {
		expect(() => hostProfilePath("../escape")).toThrow();
		expect(() => hostProfilePath("")).toThrow();
		await expect(loadHostProfile(`missing-${crypto.randomUUID().slice(0, 8)}`)).resolves.toBeUndefined();
		const profile = uniqueProfile();
		const file = hostProfilePath(profile);
		await Bun.write(file, "{ not json");
		await expect(loadHostProfile(profile)).rejects.toThrow(/corrupt/);
	});

	it("deleteHostProfile removes the binding and tolerates a missing profile", async () => {
		const profile = uniqueProfile();
		await saveHostProfile(record(profile));
		await deleteHostProfile(profile);
		await expect(loadHostProfile(profile)).resolves.toBeUndefined();
		await expect(deleteHostProfile(profile)).resolves.toBeUndefined();
	});
});
