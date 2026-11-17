import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSnapshot } from "./protocol";

/**
 * Display-only mirror of a host's agent ecosystem for collab guests: refs carry
 * `session: null`, so the local registry never owns or drives these agents.
 * Shared by the ordinary guest and the paged remote guest.
 */
export class CollabAgentMirror {
	readonly registry = new AgentRegistry();
	/** Per-agent `hasSessionFile` from the last snapshot; gates remote transcript fetches. */
	#hasTranscript = new Map<string, boolean>();

	/** Diff a host agent snapshot into the local registry (refs keep `session: null`). */
	apply(agents: AgentSnapshot[]): void {
		const seen = new Set<string>();
		for (const snap of agents) seen.add(snap.id);
		for (const ref of this.registry.list()) {
			if (!seen.has(ref.id)) {
				this.registry.unregister(ref.id);
				this.#hasTranscript.delete(ref.id);
			}
		}
		for (const snap of agents) {
			if (this.registry.get(snap.id)) {
				this.registry.setStatus(snap.id, snap.status);
			} else {
				this.registry.register({
					id: snap.id,
					displayName: snap.displayName,
					kind: snap.kind,
					parentId: snap.parentId,
					session: null,
					status: snap.status,
				});
			}
			// Refs are returned by reference: patch host timestamps directly so
			// hub age/activity columns reflect the host, not local registration.
			const ref = this.registry.get(snap.id);
			if (ref) {
				ref.createdAt = snap.createdAt;
				ref.lastActivity = snap.lastActivity;
				ref.displayName = snap.displayName;
			}
			this.#hasTranscript.set(snap.id, snap.hasSessionFile);
		}
	}

	/** Tri-state: `false` denies fetches outright, `undefined` means unknown. */
	hasTranscript(id: string): boolean | undefined {
		return this.#hasTranscript.get(id);
	}

	clear(): void {
		for (const ref of this.registry.list()) {
			this.registry.unregister(ref.id);
		}
		this.#hasTranscript.clear();
	}
}
