import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { getConfigRootDir } from "@oh-my-pi/pi-utils/dirs";
import { logger } from "@oh-my-pi/pi-utils";

/**
 * A durable host binding: the explicit session a relay room serves plus the
 * deployment endpoint, persisted under the OMP config root. Invitation URLs
 * and loopback ports are deliberately NOT part of the profile — they change
 * every run; the profile is what survives restarts.
 */
export interface HostProfileRecord {
	version: 1;
	profile: string;
	/** Session the room is bound to; never inferred from "latest session". */
	sessionId: string;
	sessionFile: string;
	/** Deployment endpoint (relay base URL). */
	relayUrl: string;
	createdAt: string;
	lastStartedAt: string;
}

const PROFILE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function hostProfilePath(profile: string): string {
	if (!PROFILE_NAME.test(profile)) throw new Error(`Invalid host profile name: ${profile}`);
	return path.join(getConfigRootDir(), "remote", "hosts", `${profile}.json`);
}

export async function loadHostProfile(profile: string): Promise<HostProfileRecord | undefined> {
	try {
		const record = (await Bun.file(hostProfilePath(profile)).json()) as HostProfileRecord;
		if (record?.version !== 1 || typeof record.sessionId !== "string" || typeof record.sessionFile !== "string") {
			throw new Error(`Host profile ${profile} is corrupt; delete it and re-run with an explicit session`);
		}
		return record;
	} catch (error) {
		if (isEnoent(error)) return undefined;
		// A truncated or hand-edited profile must surface as a decision, not a
		// mysterious parse error deep in startup.
		if (error instanceof Error && /corrupt/.test(error.message)) throw error;
		throw new Error(
			`Host profile ${profile} is corrupt (${String(error)}); delete it and re-run with an explicit session`,
		);
	}
}

/**
 * Persist the binding BEFORE the host accepts clients: a crash between the
 * write and the relay connect leaves a valid profile with no room, never the
 * reverse. Credentials live in the invitation link, which is not persisted.
 */
export async function saveHostProfile(record: HostProfileRecord): Promise<void> {
	const file = hostProfilePath(record.profile);
	const payload = `${JSON.stringify(record, undefined, "\t")}\n`;
	await Bun.write(file, payload);
	await fs.chmod(file, 0o600);
	logger.debug("host profile saved", { profile: record.profile, sessionId: record.sessionId });
}

export async function deleteHostProfile(profile: string): Promise<void> {
	try {
		await fs.rm(hostProfilePath(profile));
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}

/**
 * Resolve the session a profile-bound host run must serve. The binding is
 * explicit or it is an error: a profile without a stored binding refuses to
 * start, and a `--session` that differs from the stored binding is a hard
 * refusal — never a silent rebind onto an unrelated "latest" session.
 */
export async function resolveHostBinding(
	profile: string,
	sessionArg: string | undefined,
	resolveSessionFile: (arg: string) => Promise<string>,
): Promise<{ existing: HostProfileRecord | undefined; sessionArg: string }> {
	const existing = await loadHostProfile(profile);
	if (existing) {
		if (sessionArg) {
			const resolved = await resolveSessionFile(sessionArg);
			if (resolved !== existing.sessionFile) {
				throw new Error(
					`Profile ${profile} is bound to ${existing.sessionFile}; refusing to bind ${resolved}. Use a different --profile or delete the profile.`,
				);
			}
		}
		return { existing, sessionArg: existing.sessionFile };
	}
	if (!sessionArg) throw new Error(`Profile ${profile} has no binding yet; pass --session=<file|id> once`);
	return { existing, sessionArg };
}
