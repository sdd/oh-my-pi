import { isRecord } from "@oh-my-pi/pi-utils";
import type { LocationFix } from "./capture";
import { importGpx, locateCaptureTime, validLocation } from "./location";

interface ReportEvent {
	captureId: string;
	role: "client" | "server";
	event: string;
	timestamp: number;
	monotonicMs: number;
	values: Record<string, number | boolean>;
	location?: LocationFix;
	mark?: string;
}

export function parseCapture(source: string): ReportEvent[] {
	const { values } = Bun.JSONL.parseChunk(source);
	const events: ReportEvent[] = [];
	for (const value of values as unknown[]) {
		if (
			!isRecord(value) ||
			value.version !== 1 ||
			typeof value.captureId !== "string" ||
			(value.role !== "client" && value.role !== "server") ||
			typeof value.event !== "string" ||
			typeof value.timestamp !== "number" ||
			!Number.isFinite(value.timestamp) ||
			typeof value.monotonicMs !== "number" ||
			!Number.isFinite(value.monotonicMs)
		)
			continue;
		const numeric: Record<string, number | boolean> = {};
		if (isRecord(value.values))
			for (const [key, field] of Object.entries(value.values)) {
				if (typeof field === "boolean" || (typeof field === "number" && Number.isFinite(field)))
					numeric[key] = field;
			}
		let location: LocationFix | undefined;
		if (isRecord(value.location)) {
			const item = value.location;
			if (
				(item.source === "macos" || item.source === "phone") &&
				typeof item.timestamp === "number" &&
				typeof item.latitude === "number" &&
				typeof item.longitude === "number"
			) {
				const fix: LocationFix = {
					source: item.source,
					timestamp: item.timestamp,
					latitude: item.latitude,
					longitude: item.longitude,
					accuracyM: typeof item.accuracyM === "number" ? item.accuracyM : undefined,
				};
				if (validLocation(fix)) location = fix;
			}
		}
		events.push({
			captureId: value.captureId,
			role: value.role,
			event: value.event,
			timestamp: value.timestamp,
			monotonicMs: value.monotonicMs,
			values: numeric,
			location,
			mark: typeof value.mark === "string" ? value.mark.slice(0, 256) : undefined,
		});
	}
	return events;
}

function percentiles(values: number[]): { p50: number | null; p95: number | null; p99: number | null } {
	values.sort((a, b) => a - b);
	const at = (p: number): number | null =>
		values.length ? values[Math.max(0, Math.ceil(p * values.length) - 1)] : null;
	return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

export function buildCaptureReport(client: string, server?: string, gpx?: string, includeLocation = true): object {
	const clientEvents = parseCapture(client);
	const serverEvents = server === undefined ? [] : parseCapture(server);
	if (
		!clientEvents.length ||
		clientEvents.some(event => event.role !== "client") ||
		(server !== undefined && (!serverEvents.length || serverEvents.some(event => event.role !== "server")))
	)
		throw new Error("Expected a client recording and, when supplied, a server recording");
	const events = [...clientEvents, ...serverEvents];
	const ids = new Set(events.map(event => event.captureId));
	if (ids.size !== 1) throw new Error("Expected exactly one matching capture ID across recordings");
	const sources = new Set(events.map(event => event.role));
	const endpointStats = [...sources].map(role => {
		const local = events.filter(event => event.role === role);
		const sum = (name: string): number =>
			local
				.filter(event => event.event === name)
				.reduce((total, event) => total + (typeof event.values.bytes === "number" ? event.values.bytes : 0), 0);
		const cpu = local.filter(
			event => typeof event.values.cpuUserUs === "number" && typeof event.values.cpuSystemUs === "number",
		);
		const first = cpu[0]?.values;
		const last = cpu.at(-1)?.values;
		const transport = local.filter(event => event.event === "transport");
		const payloadBytes = (sent: boolean): number =>
			transport.reduce(
				(total, event) =>
					total + (event.values.sent === sent && typeof event.values.bytes === "number" ? event.values.bytes : 0),
				0,
			);
		return {
			role,
			records: local.length,
			requestPayloadBytes: sum("request"),
			responsePayloadBytes: sum("response"),
			webSocketPayloadBytesSent: payloadBytes(true),
			webSocketPayloadBytesReceived: payloadBytes(false),
			peakBufferedBytes: transport.reduce(
				(peak, event) =>
					Math.max(peak, typeof event.values.bufferedBytes === "number" ? event.values.bufferedBytes : 0),
				0,
			),
			cleanStop: local.at(-1)?.event === "stop",
			droppedRecords: local.reduce(
				(peak, event) => Math.max(peak, typeof event.values.dropped === "number" ? event.values.dropped : 0),
				0,
			),
			peakRssBytes: local.reduce(
				(peak, event) => Math.max(peak, typeof event.values.rssBytes === "number" ? event.values.rssBytes : 0),
				0,
			),
			cpuMs:
				first && last
					? (Number(last.cpuUserUs) +
							Number(last.cpuSystemUs) -
							Number(first.cpuUserUs) -
							Number(first.cpuSystemUs)) /
						1000
					: null,
		};
	});
	const fixes = includeLocation
		? [...events.flatMap(event => (event.location ? [event.location] : [])), ...(gpx ? importGpx(gpx) : [])]
		: [];
	const latencies: number[] = [];
	const outages: { start: number; end?: number; durationMs?: number }[] = [];
	const requests = new Map<number, number>();
	const timeline: object[] = [];
	let activeOutage: { start: number; monotonicMs: number } | undefined;
	let peakRssBytes = 0;
	let peakCacheBytes = 0;
	let bytesReceived = 0;
	for (const event of events.filter(event => event.role === "client")) {
		if (event.event === "request" && event.values.history !== false && typeof event.values.reqId === "number")
			requests.set(event.values.reqId, event.monotonicMs);
		if (event.event === "response" && event.values.history !== false && typeof event.values.reqId === "number") {
			const start = requests.get(event.values.reqId);
			if (start !== undefined && event.monotonicMs >= start) {
				latencies.push(event.monotonicMs - start);
				requests.delete(event.values.reqId);
			}
		}
		if (event.event === "disconnected" && !activeOutage)
			activeOutage = { start: event.timestamp, monotonicMs: event.monotonicMs };
		if (event.event === "connected" && activeOutage) {
			outages.push({
				start: activeOutage.start,
				end: event.timestamp,
				durationMs: Math.max(0, event.monotonicMs - activeOutage.monotonicMs),
			});
			activeOutage = undefined;
		}
		if (typeof event.values.rssBytes === "number") peakRssBytes = Math.max(peakRssBytes, event.values.rssBytes);
		if (typeof event.values.cacheBytes === "number")
			peakCacheBytes = Math.max(peakCacheBytes, event.values.cacheBytes);
		if (event.event === "response" && typeof event.values.bytes === "number") bytesReceived += event.values.bytes;
		timeline.push({
			event: event.event,
			timestamp: event.timestamp,
			values: event.values,
			...(event.mark === undefined ? {} : { mark: event.mark }),
			...(includeLocation ? { location: locateCaptureTime(event.timestamp, fixes) } : {}),
		});
	}
	if (activeOutage) outages.push({ start: activeOutage.start });
	return {
		version: 1,
		captureId: [...ids][0],
		endpoints: [...sources],
		endpointStats,
		byteAccounting:
			"Application payload counts are decoded JSON. WebSocket payload counts include encryption and relay controls, excluding WebSocket framing and TCP/TLS overhead. Sent bytes entered the socket buffer; delivery is not implied.",
		requestLatencyMs: percentiles(latencies),
		completedRequests: latencies.length,
		bytesReceived,
		peakRssBytes,
		peakCacheBytes,
		outages,
		timeline,
		...(includeLocation
			? {
					route: {
						type: "FeatureCollection",
						features: fixes.map(fix => ({
							type: "Feature",
							geometry: { type: "Point", coordinates: [fix.longitude, fix.latitude] },
							properties: { source: fix.source, timestamp: fix.timestamp, accuracyM: fix.accuracyM },
						})),
					},
				}
			: {}),
		impairmentScenario: {
			seed: 1,
			outageDurationsMs: outages.flatMap(outage => (outage.durationMs === undefined ? [] : [outage.durationMs])),
			note: "Application-observed outages; not a measurement of physical link loss or capacity",
		},
	};
}
