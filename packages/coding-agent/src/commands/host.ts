import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils/dirs";
import { Reason } from "@oh-my-pi/pi-utils/postmortem";
import { Settings } from "../config/settings";
import { CollabHost, CollabHostStoppedError } from "../collab/host";
import { resolveHostBinding, saveHostProfile } from "../collab/host-profile";
import { DEFAULT_RELAY_URL } from "../collab/protocol";
import { cfgCollabRelayUrl } from "../collab/settings";
import { resolveSessionFileArg } from "../cli/session-arg";
import type { CollabHostContext } from "../modes/types";
import { initializeExtensions } from "../modes/runtime-init";
import { createAgentSession } from "../sdk";
import { SessionManager } from "../session/session-manager";

/**
 * Persistent headless collab host: one process, one explicitly bound session,
 * no local UI. Guests attach, disconnect, and reattach across this process's
 * own restarts; the durable binding lives in the host profile, which is
 * written before the room accepts any client.
 */
export default class Host extends Command {
	static description =
		"Serve a bound session to remote paged guests (persistent host; survives guest disconnects and restarts)";

	static args = {};

	static flags = {
		profile: Flags.string({
			description: "Durable host profile name that binds this room to one session",
			required: true,
		}),
		session: Flags.string({
			description: "Session file or ID prefix to bind (required when the profile has no binding yet)",
		}),
		relay: Flags.string({
			description: "Relay endpoint (host[:port] defaults to wss; full ws:// or wss:// URL allowed)",
		}),
		cwd: Flags.string({
			description: "Working directory for the session (default: the session's recorded directory)",
		}),
	};

	static examples = [
		"omp host --profile train --session ~/.omp/sessions/2026/11/abc.jsonl",
		"omp host --profile train",
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(Host);
		if (!flags.profile) throw new CliUsageError("--profile is required");
		const profileName = flags.profile;
		const { existing, sessionArg } = await resolveHostBinding(profileName, flags.session, arg =>
			resolveSessionFileArg(arg, getProjectDir()),
		);

		const cwd = getProjectDir();
		const settings = await Settings.init({ cwd });
		const relayInput = flags.relay?.trim() || cfgCollabRelayUrl.get(settings) || DEFAULT_RELAY_URL;
		// Scheme-less relay args default to wss (ws:// must be spelled out for localhost).
		const relayUrl = relayInput.includes("://") ? relayInput : `wss://${relayInput}`;

		const sessionPath = await resolveSessionFileArg(sessionArg, cwd);
		const sessionManager = await SessionManager.open(sessionPath, undefined, undefined, { throwIfMissing: true });
		const header = sessionManager.getHeader();
		const sessionCwd = flags.cwd ?? header?.cwd ?? cwd;
		try {
			setProjectDir(sessionCwd);
		} catch {
			// A missing recorded directory falls back to the launch cwd.
		}

		const { session, eventBus, subagentEventBus } = await createAgentSession({
			sessionManager,
			cwd: sessionCwd,
			settings,
		});
		await initializeExtensions(session, {
			mode: "print",
			reportSendError: (action, error) => {
				process.stderr.write(
					`Extension ${action === "extension_send" ? "sendMessage" : "sendUserMessage"} failed: ${error.message}\n`,
				);
			},
			reportRuntimeError: error => {
				process.stderr.write(`Extension error (${error.extensionPath}): ${error.error}\n`);
			},
		});

		const context: CollabHostContext = {
			session,
			sessionManager,
			settings,
			ui: { requestRender() {} },
			statusLine: {
				setCollabStatus() {},
				invalidate() {},
				getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
			},
			showStatus: message => {
				process.stderr.write(`collab: ${message}\n`);
			},
			updatePendingMessagesDisplay() {},
			eventBus,
			subagentEventBus,
		};
		const host = new CollabHost(context, {
			onEnded: () => {
				process.exitCode = 0;
			},
		});
		// The binding exists before the room does: a crash between the write and
		// the relay connect leaves a valid profile with no clients, never the
		// reverse.
		await saveHostProfile({
			version: 1,
			profile: profileName,
			sessionId: sessionManager.getSessionId(),
			sessionFile: sessionManager.getSessionFile() ?? sessionPath,
			relayUrl,
			createdAt: existing?.createdAt ?? new Date().toISOString(),
			lastStartedAt: new Date().toISOString(),
		});
		try {
			await host.start(relayUrl);
		} catch (error) {
			if (error instanceof CollabHostStoppedError) return;
			throw error;
		}
		process.stdout.write(`Hosting session ${sessionManager.getSessionId()} as profile ${profileName}\n`);
		process.stdout.write(`Join:        omp join --paged "${host.link}"\n`);
		process.stdout.write(`View only:   omp join --paged "${host.viewLink}"\n`);
		process.stdout.write("The host keeps running without guests. Ctrl+C stops it.\n");

		const shutdown = Promise.withResolvers<void>();
		let sigint = false;
		const onSignal = (): void => {
			if (sigint) return;
			sigint = true;
			shutdown.resolve();
		};
		process.on("SIGINT", onSignal);
		process.on("SIGTERM", onSignal);
		try {
			// `host.stopped` is a boolean getter — awaiting it would race nothing;
			// `whenStopped` is the promise that actually resolves when the room ends.
			await Promise.race([shutdown.promise, host.whenStopped]);
		} finally {
			process.off("SIGINT", onSignal);
			process.off("SIGTERM", onSignal);
			await host.stop("host command exiting");
			await session.dispose({ reason: Reason.MANUAL }).catch(() => {});
		}
	}
}
