import * as fs from "node:fs/promises";
import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { buildCaptureReport } from "../remote/report";

export default class CaptureReport extends Command {
	static description = "Correlate local remote-agent captures and an optional phone GPX track";
	static args = { client: Args.string({ required: true, description: "Client capture JSONL" }) };
	static flags = {
		server: Flags.string({ description: "Matching server capture JSONL" }),
		gpx: Flags.string({ description: "Phone GPS track recorded during the capture" }),
		out: Flags.string({ required: true, description: "New report JSON file (never overwritten)" }),
		"omit-location": Flags.boolean({
			default: false,
			description: "Exclude all location information from the report",
		}),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(CaptureReport);
		if (!args.client || !flags.out)
			throw new CliUsageError(
				"Usage: omp capture-report <client.jsonl> --out <report.json> [--server <server.jsonl>] [--gpx <track.gpx>]",
			);
		const read = async (file: string): Promise<string> => {
			const source = Bun.file(file);
			if (source.size > 256 * 1024 * 1024) throw new Error("Capture input exceeds 256 MiB");
			return source.text();
		};
		const report = buildCaptureReport(
			await read(args.client),
			flags.server ? await read(flags.server) : undefined,
			flags.gpx && !flags["omit-location"] ? await read(flags.gpx) : undefined,
			!flags["omit-location"],
		);
		const output = await fs.open(flags.out, "wx", 0o600);
		try {
			await output.writeFile(`${JSON.stringify(report, null, 2)}\n`);
		} finally {
			await output.close();
		}
		process.stdout.write(`${flags.out}\n`);
	}
}
