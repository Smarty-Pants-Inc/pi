// pi#95 R8: name-keyed npm caches must not lend one tag's code another tag's source grant.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../../../src/core/event-bus.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { type SessionEntry, SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { getTurnProvenance, type TurnProvenanceClaim } from "../../../src/core/turn-provenance.ts";
import { createHarness, type Harness } from "../harness.ts";

const claims: TurnProvenanceClaim[] = [
	{ channel: "voice", principal: { id: "paul" } },
	{ channel: "fabric", sender: { id: "session:org", kind: "main", verified: "mesh" }, via: "steer" },
];
const directories: string[] = [];
const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length) harnesses.pop()?.cleanup();
	while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

describe("pi#95 cached npm tag attribution", () => {
	for (const ingress of ["global-packages", "additionalExtensionPaths"] as const) {
		for (const claim of claims) {
			it.each(["voice-package", "@fixture/voice-package"])(
				`${ingress}: ${claim.channel} %s tags, file and version controls survive reopen`,
				async (name) => {
					const root = mkdtempSync(join(tmpdir(), "pi-95-npm-tags-"));
					directories.push(root);
					const cwd = join(root, "project");
					const agentDir = join(root, "agent");
					for (const dir of [cwd, agentDir]) mkdirSync(dir, { recursive: true });
					const npm = join(root, "npm-fixture.cjs");
					const installs = join(root, "installs.jsonl");
					// A local CLI fixture exercises real package resolution without contacting or mutating a registry.
					writeFileSync(
						npm,
						`
					const fs = require("node:fs");
					const path = require("node:path");
					const args = process.argv.slice(2);
					if (args[0] === "root") { console.log(${JSON.stringify(join(root, "legacy"))}); }
					else if (args[0] === "install") {
						const spec = args[1];
						const dir = path.join(args[args.indexOf("--prefix") + 1], "node_modules", ${JSON.stringify(name)});
						fs.mkdirSync(dir, { recursive: true });
						fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: ${JSON.stringify(name)}, version: spec.endsWith("@approved") ? "2.0.0" : "1.0.0", pi: { extensions: ["index.ts"] } }));
						fs.writeFileSync(path.join(dir, "index.ts"), 'export default function(pi) { pi.events.emit("loaded-api", { api: pi, marker: ' + JSON.stringify(spec) + ' }); }');
						fs.appendFileSync(${JSON.stringify(installs)}, JSON.stringify(spec) + "\\n");
					} else { throw new Error("Unexpected fixture npm command: " + args); }
				`,
					);
					vi.stubEnv("PI_OFFLINE", "0");
					let installedFile: string | undefined;
					for (const phase of [
						"unapproved",
						"approved",
						"same-tag",
						"offline",
						"implicit-latest",
						"malformed-selector",
						"file-trust",
						"version",
						"range",
						"fresh-approved",
					] as const) {
						const profile = phase === "fresh-approved" ? join(root, "fresh-agent") : agentDir;
						mkdirSync(profile, { recursive: true });
						vi.stubEnv("PI_OFFLINE", phase === "offline" ? "1" : "0");
						const version =
							phase === "version"
								? "1.0.0"
								: phase === "range"
									? "^1.0.0"
									: phase === "unapproved"
										? "unapproved"
										: "approved";
						const source =
							phase === "implicit-latest"
								? `npm:${name}`
								: phase === "malformed-selector"
									? `npm:${name}@approved@1.0.0`
									: `npm:${name}@${version}`;
						const allowed =
							phase === "file-trust"
								? installedFile!
								: phase === "version" ||
										phase === "range" ||
										phase === "implicit-latest" ||
										phase === "malformed-selector"
									? source
									: `npm:${name}@approved`;
						writeFileSync(
							join(profile, "settings.json"),
							JSON.stringify({
								npmCommand: [process.execPath, npm],
								...(ingress === "global-packages" ? { packages: [source] } : {}),
								turnProvenance: { voiceExtensions: [allowed], fabricExtensions: [allowed] },
							}),
						);
						const settings = SettingsManager.create(cwd, profile);
						let api!: ExtensionAPI;
						let marker: string | undefined;
						const eventBus = createEventBus();
						eventBus.on("loaded-api", (value) => {
							({ api, marker } = value as { api: ExtensionAPI; marker: string });
						});
						const loader = new DefaultResourceLoader({
							cwd,
							agentDir: profile,
							settingsManager: settings,
							eventBus,
							noContextFiles: true,
							additionalExtensionPaths: ingress === "additionalExtensionPaths" ? [source] : [],
						});
						await loader.reload();
						expect(loader.getExtensions().errors).toEqual([]);
						expect(loader.getExtensions().extensions).toHaveLength(1);
						installedFile = loader.getExtensions().extensions[0].resolvedPath;
						expect(marker).toBe(`${name}@${phase === "fresh-approved" ? "approved" : "unapproved"}`);
						expect(readFileSync(installs, "utf8").trim().split("\n")).toEqual([
							JSON.stringify(`${name}@unapproved`),
							...(phase === "fresh-approved" ? [JSON.stringify(`${name}@approved`)] : []),
						]);
						const harness = await createHarness({
							persistSession: true,
							resourceLoader: loader,
							settings: settings.getGlobalSettings(),
						});
						harnesses.push(harness);
						await harness.session.bindExtensions({});
						harness.setResponses([fauxAssistantMessage("done")]);
						api.sendMessage({ customType: "npm-claim", content: marker!, display: false }, { provenance: claim });
						api.sendUserMessage(marker!, { provenance: claim });
						await vi.waitFor(() =>
							expect(
								harness.sessionManager.getEntries().filter((entry) => getTurnProvenance(entry)),
							).toHaveLength(2),
						);
						await harness.session.agent.waitForIdle();
						const entries = harness.sessionManager.getEntries().filter((entry) => getTurnProvenance(entry));
						const records = entries.map(getTurnProvenance);
						// PR #95 R8: even checked semver selectors do not attest complete implementation coverage.
						const trusted = phase === "file-trust";
						const channels = trusted ? [claim.channel, claim.channel] : ["terminal", "terminal"];
						expect(entries.map((entry) => entry.type)).toEqual(["custom_message", "message"]);
						expect
							.soft(
								records.map((record) => record?.channel),
								phase,
							)
							.toEqual(channels);
						for (const record of records) {
							if (!trusted) {
								expect.soft(record?.principal, phase).toBeUndefined();
								expect.soft(record?.sender, phase).toBeUndefined();
							} else if (claim.channel === "voice") {
								expect(record?.principal).toEqual({ id: "paul", binding: "voice-call" });
							} else {
								expect(record?.sender).toEqual(claim.sender);
								expect(record?.via).toBe("steer");
							}
						}
						expect(records[0]?.turnId).not.toBe(records[1]?.turnId);
						const file = harness.sessionManager.getSessionFile()!;
						const jsonl = readFileSync(file, "utf8")
							.trim()
							.split("\n")
							.map((line) => JSON.parse(line) as SessionEntry);
						expect(jsonl.filter((entry) => getTurnProvenance(entry)).map(getTurnProvenance)).toEqual(records);
						const reopened = SessionManager.open(file, harness.tempDir);
						expect(
							reopened
								.getEntries()
								.filter((entry) => getTurnProvenance(entry))
								.map(getTurnProvenance),
						).toEqual(records);
						expect(
							reopened
								.buildSessionContext()
								.messages.filter((message) => message.role === "user" || message.role === "custom"),
						).toHaveLength(2);
					}
				},
				30_000,
			);
		}
	}
});
