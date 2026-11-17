import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import { readLines } from "@oh-my-pi/pi-utils/stream";
import { getConfigRootDir } from "@oh-my-pi/pi-utils/dirs";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import source from "./location.swift" with { type: "text" };
import plist from "./location.plist" with { type: "text" };
import type { LocationFix, RemoteCapture } from "./capture";
import { validLocation } from "./location";

export function parseMacLocation(line: string): LocationFix | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (
		!isRecord(value) ||
		value.source !== "macos" ||
		typeof value.timestamp !== "number" ||
		typeof value.latitude !== "number" ||
		typeof value.longitude !== "number" ||
		typeof value.accuracyM !== "number"
	)
		return undefined;
	const fix: LocationFix = {
		source: "macos",
		timestamp: value.timestamp,
		latitude: value.latitude,
		longitude: value.longitude,
		accuracyM: value.accuracyM,
	};
	return validLocation(fix) ? fix : undefined;
}

/** Compile an identified, permission-prompting macOS helper only when capture requests location. */
export async function startMacLocation(
	capture: RemoteCapture,
	onStatus: (status: string) => void,
): Promise<() => void> {
	if (process.platform !== "darwin") {
		onStatus("Mac location is unavailable on this platform");
		return () => {};
	}
	const directory = path.join(getConfigRootDir(), "remote", "location-helper");
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	const binary = path.join(directory, `location-${Bun.hash(source + plist).toString(16)}`);
	if (!(await Bun.file(binary).exists())) {
		const temporary = path.join(directory, crypto.randomUUID());
		await fs.mkdir(temporary, { mode: 0o700 });
		try {
			const swift = path.join(temporary, "location.swift");
			const info = path.join(temporary, "Info.plist");
			await Bun.write(swift, source);
			await Bun.write(info, plist);
			const compiled = path.join(temporary, "location");
			const result =
				await $`/usr/bin/xcrun swiftc -O ${swift} -o ${compiled} -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker ${info}`
					.quiet()
					.nothrow();
			if (result.exitCode !== 0) throw new Error("Cannot build location helper; install Apple's Command Line Tools");
			await fs.rename(compiled, binary);
		} finally {
			await fs.rm(temporary, { recursive: true, force: true });
		}
	}
	if (capture.status.closed) return () => {};
	const child = Bun.spawn([binary], { stdout: "pipe", stderr: "ignore" });
	let stopped = false;
	const stop = (): void => {
		if (stopped) return;
		stopped = true;
		child.kill();
	};
	const unsubscribe = capture.onStop(stop);
	void (async () => {
		for await (const bytes of readLines(child.stdout as ReadableStream<Uint8Array>)) {
			const fix = parseMacLocation(new TextDecoder().decode(bytes));
			if (fix) {
				capture.record("location", undefined, undefined, fix);
				onStatus("Mac location recording");
			} else {
				capture.record("location-unavailable");
				onStatus("Mac location pending or unavailable");
			}
		}
		if (!stopped) onStatus("Mac location helper stopped");
	})().catch(error => {
		logger.warn("Remote location capture stopped", { error: String(error) });
		onStatus("Mac location unavailable");
	});
	return () => {
		unsubscribe();
		stop();
	};
}
