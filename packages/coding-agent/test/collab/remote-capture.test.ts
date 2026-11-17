import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RemoteCapture, type LocationFix } from "../../src/remote/capture";
import { importGpx, locateCaptureTime } from "../../src/remote/location";
import { buildCaptureReport, parseCapture } from "../../src/remote/report";
import { parseMacLocation } from "../../src/remote/mac-location";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe("local capture and route correlation", () => {
	it("writes private ordered records and stops at the byte limit without recursive shutdown", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-remote-capture-"));
		directories.push(directory);
		const capture = await RemoteCapture.start({ id: crypto.randomUUID(), role: "client", directory, maxBytes: 1024 });
		let stopped = 0;
		capture.onStop(() => {
			stopped++;
		});
		capture.record("request", { reqId: 1 });
		capture.record("response", { reqId: 1 });
		capture.record("mark", undefined, "x".repeat(256));
		capture.record("mark", undefined, "x".repeat(256));
		await capture.stop();
		const file = Bun.file(capture.file);
		expect(file.size).toBeLessThanOrEqual(1024);
		const records = Bun.JSONL.parse(await file.text()) as { event: string; values?: { reqId: number } }[];
		expect(records.slice(0, 3).map(record => record.event)).toEqual(["start", "request", "response"]);
		expect(records[1].values?.reqId).toBe(records[2].values?.reqId);
		expect(capture.status.closed).toBe(true);
		expect(capture.status.error).toBe("Capture byte limit reached");
		expect(stopped).toBe(1);
		expect((await fs.stat(capture.file)).mode & 0o777).toBe(0o600);
	});

	it("imports timestamped namespaced phone points, skips invalid points and never invents GPS accuracy", () => {
		const points = importGpx(`<g:gpx xmlns:g="http://www.topografix.com/GPX/1/1"><g:trk><g:trkseg>
			<g:trkpt lat="51.5" lon="-0.1"><g:time>2026-11-17T08:00:00Z</g:time><g:hdop>1</g:hdop></g:trkpt>
			<g:trkpt lat="99" lon="-0.1"><g:time>2026-11-17T08:01:00Z</g:time></g:trkpt>
			<g:trkpt lat="51.6" lon="-0.2"/>
			<g:trkpt lat="51.6" lon="-0.2"><g:time>2026-11-17T08:02:00</g:time></g:trkpt>
		</g:trkseg></g:trk></g:gpx>`);
		expect(points).toEqual([
			{ source: "phone", timestamp: Date.parse("2026-11-17T08:00:00Z"), latitude: 51.5, longitude: -0.1 },
		]);
	});

	it("retains both sources, prefers nearby phone fixes, and leaves a tunnel gap unlocated", () => {
		const phone = { source: "phone" as const, timestamp: 1_000, latitude: 51.5, longitude: -0.1 };
		const macos = { source: "macos" as const, timestamp: 2_000, latitude: 51.51, longitude: -0.11, accuracyM: 500 };
		expect(locateCaptureTime(2_000, [phone, macos])).toEqual({ phone, macos, preferred: phone });
		expect(locateCaptureTime(100_000, [phone, macos])).toEqual({ preferred: undefined });
	});

	it("rejects invalid Mac fixes and preserves the OS timestamp instead of making stale data fresh", () => {
		const fix: LocationFix = { source: "macos", timestamp: 1000, latitude: 51.5, longitude: -0.1, accuracyM: 50 };
		expect(parseMacLocation(JSON.stringify(fix))).toEqual(fix);
		expect(parseMacLocation(JSON.stringify({ ...fix, accuracyM: -1 }))).toBeUndefined();
		expect(parseMacLocation('{"unavailable":"denied"}')).toBeUndefined();
		expect(parseMacLocation("broken")).toBeUndefined();
	});

	it("measures local request latency despite clock skew, tolerates a truncated final record and omits location on export", () => {
		const id = crypto.randomUUID();
		const event = (name: string, monotonicMs: number, extra: object = {}): string =>
			JSON.stringify({
				version: 1,
				captureId: id,
				role: "client",
				event: name,
				timestamp: 100_000 + monotonicMs,
				monotonicMs,
				...extra,
			});
		const client =
			[
				event("request", 10, { values: { reqId: 1 } }),
				event("response", 40, { values: { reqId: 1, bytes: 100 } }),
				event("disconnected", 50),
				event("connected", 200),
				event("mark", 210, { mark: "tunnel exit" }),
				event("location", 220, {
					location: { source: "macos", timestamp: 100_220, latitude: 51.5, longitude: -0.1 },
				}),
			].join("\n") + '\n{"truncated":';
		const server =
			JSON.stringify({
				version: 1,
				captureId: id,
				role: "server",
				event: "response",
				timestamp: 1,
				monotonicMs: 900_000,
				values: { reqId: 1 },
			}) + "\n";
		expect(parseCapture(client)).toHaveLength(6);
		expect(buildCaptureReport(client, server)).toMatchObject({
			completedRequests: 1,
			requestLatencyMs: { p50: 30, p95: 30, p99: 30 },
			bytesReceived: 100,
			outages: [{ durationMs: 150 }],
			endpointStats: [
				{ role: "client", responsePayloadBytes: 100 },
				{ role: "server", records: 1 },
			],
			timeline: [{}, {}, {}, {}, { event: "mark", mark: "tunnel exit" }, {}],
		});
		const privateReport = JSON.stringify(buildCaptureReport(client, server, undefined, false));
		expect(privateReport).not.toContain("latitude");
		expect(privateReport).not.toContain("longitude");
		expect(privateReport).not.toContain("FeatureCollection");
		expect(() => buildCaptureReport(client, server.replace(id, crypto.randomUUID()))).toThrow("matching capture ID");
		expect(() => buildCaptureReport(server, client)).toThrow("client recording");
	});
});
