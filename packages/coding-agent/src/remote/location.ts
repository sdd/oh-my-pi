import { attribute, descendants, firstChild, localName, parseXml } from "@oh-my-pi/pi-utils/docx/xml";
import type { LocationFix } from "./capture";

export function validLocation(fix: LocationFix): boolean {
	return (
		Number.isFinite(fix.timestamp) &&
		Number.isFinite(fix.latitude) &&
		Math.abs(fix.latitude) <= 90 &&
		Number.isFinite(fix.longitude) &&
		Math.abs(fix.longitude) <= 180 &&
		(fix.accuracyM === undefined || (Number.isFinite(fix.accuracyM) && fix.accuracyM >= 0))
	);
}

/** Timestamped track points only; missing accuracy is unknown, never invented from HDOP. */
export function importGpx(source: string): LocationFix[] {
	if (Buffer.byteLength(source) > 32 * 1024 * 1024) throw new Error("GPX file exceeds 32 MiB");
	const root = parseXml(source);
	if (localName(root.name) !== "gpx") throw new Error("Expected a GPX document");
	const points: LocationFix[] = [];
	for (const point of descendants(root, "trkpt")) {
		const time = firstChild(point, "time");
		const latitude = attribute(point, "lat");
		const longitude = attribute(point, "lon");
		if (!time || latitude === undefined || longitude === undefined || !latitude.trim() || !longitude.trim()) continue;
		const timeText = time.children
			.filter(child => child.kind === "text")
			.map(child => child.value)
			.join("");
		if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(timeText)) continue;
		const timestamp = Date.parse(timeText);
		const fix: LocationFix = { source: "phone", timestamp, latitude: Number(latitude), longitude: Number(longitude) };
		if (validLocation(fix)) points.push(fix);
	}
	return points.sort((a, b) => a.timestamp - b.timestamp);
}

/** Keep both measurements; prefer a nearby phone fix without interpolating across a gap. */
export function locateCaptureTime(
	timestamp: number,
	fixes: readonly LocationFix[],
	maxAgeMs = 30_000,
): { preferred?: LocationFix; macos?: LocationFix; phone?: LocationFix } {
	const nearest: { macos?: LocationFix; phone?: LocationFix } = {};
	for (const fix of fixes) {
		if (!validLocation(fix) || Math.abs(fix.timestamp - timestamp) > maxAgeMs) continue;
		const previous = nearest[fix.source];
		if (!previous || Math.abs(fix.timestamp - timestamp) < Math.abs(previous.timestamp - timestamp))
			nearest[fix.source] = fix;
	}
	return { ...nearest, preferred: nearest.phone ?? nearest.macos };
}
