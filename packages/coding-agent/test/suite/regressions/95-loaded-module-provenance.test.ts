// pi#95 R6: attribution belongs to the module actually evaluated, not a mutable filename.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
const harnesses: Harness[] = [];
const directories: string[] = [];
afterEach(() => {
	while (harnesses.length) harnesses.pop()?.cleanup();
	while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

const scenarios = [
	"unicode-approved",
	"unicode-unapproved",
	"unicode-preload",
	"unicode-thin-approved",
	"unicode-thin-unapproved",
	"confusable-unapproved",
	"ascii-unapproved",
	"unicode-directory-unapproved",
	"manifest-escape",
	"post-finalization-symlink",
	"post-finalization-content",
	"factory-target-deletion",
	"module-target-deletion",
	"stable-file",
	"stable-package",
] as const;

describe("pi#95 loaded module identity", () => {
	for (const scenario of scenarios) {
		for (const claim of claims) {
			it(`${scenario}: ${claim.channel} through loader, both sends, persistence and reopen`, async () => {
				const root = mkdtempSync(join(tmpdir(), "pi-95-loaded-module-"));
				directories.push(root);
				const cwd = join(root, "project");
				const agentDir = join(root, "agent");
				const approved = join(root, "approved");
				for (const dir of [cwd, agentDir, approved]) mkdirSync(dir, { recursive: true });
				const approvedFile = join(approved, "caller.ts");
				const outsideFile = join(root, "outside.ts");
				const unicodeName =
					scenario === "confusable-unapproved"
						? "vo\u0456ce.ts"
						: scenario.startsWith("unicode-thin")
							? "voice\u2009.ts"
							: "voice\u00a0.ts";
				const unicodeFile = join(root, unicodeName);
				const asciiFile = join(root, scenario === "confusable-unapproved" ? "voice.ts" : "voice .ts");
				const stable = (marker: string) => `export default function(pi) {
					pi.events.emit("loaded-api", { api: pi, marker: ${JSON.stringify(marker)} });
				}`;
				writeFileSync(approvedFile, stable("approved"));
				writeFileSync(asciiFile, stable("ascii"));
				writeFileSync(unicodeFile, stable("unicode"));
				let source = outsideFile;
				let allowed = approvedFile;
				let expectedMarker = "outside";
				let trusted = false;
				let factoryMutation = "";
				let moduleMutation = "";
				let laterMutation = "";
				switch (scenario) {
					case "unicode-approved":
					case "unicode-unapproved":
					case "unicode-preload":
					case "unicode-thin-approved":
					case "unicode-thin-unapproved":
					case "confusable-unapproved":
						source = unicodeFile;
						trusted =
							scenario === "unicode-approved" ||
							scenario === "unicode-thin-approved" ||
							scenario === "unicode-preload";
						allowed = trusted ? unicodeFile : asciiFile;
						expectedMarker = "unicode";
						break;
					case "ascii-unapproved":
						source = asciiFile;
						allowed = unicodeFile;
						expectedMarker = "ascii";
						break;
					case "unicode-directory-unapproved":
						source = approved;
						allowed = `${approved}\u00a0`;
						expectedMarker = "approved";
						mkdirSync(allowed);
						writeFileSync(join(allowed, "caller.ts"), stable("unicode"));
						writeFileSync(join(approved, "package.json"), JSON.stringify({ pi: { extensions: ["caller.ts"] } }));
						break;
					case "manifest-escape":
						source = approved;
						allowed = approved;
						writeFileSync(
							join(approved, "package.json"),
							JSON.stringify({ pi: { extensions: ["../outside.ts"] } }),
						);
						break;
					case "post-finalization-symlink":
						laterMutation = `rmSync(${JSON.stringify(outsideFile)}); symlinkSync(${JSON.stringify(approvedFile)}, ${JSON.stringify(outsideFile)}, "file");`;
						break;
					case "post-finalization-content":
						source = approvedFile;
						expectedMarker = "approved";
						laterMutation = `writeFileSync(${JSON.stringify(approvedFile)}, ${JSON.stringify(stable("replacement"))});`;
						break;
					case "factory-target-deletion":
					case "module-target-deletion":
						source = join(approved, "linked.ts");
						allowed = `${approved}/`;
						symlinkSync(outsideFile, source, "file");
						if (scenario === "factory-target-deletion")
							factoryMutation = `rmSync(${JSON.stringify(outsideFile)});`;
						else moduleMutation = `rmSync(${JSON.stringify(outsideFile)});`;
						break;
					case "stable-file":
						source = approvedFile;
						expectedMarker = "approved";
						trusted = true;
						break;
					case "stable-package":
						source = approved;
						allowed = approved;
						expectedMarker = "approved";
						trusted = true;
						writeFileSync(join(approved, "package.json"), JSON.stringify({ pi: { extensions: ["caller.ts"] } }));
						break;
				}
				const mutableModule = `import { rmSync, symlinkSync, writeFileSync } from "node:fs";
					${moduleMutation}
					export default function(pi) {
						${factoryMutation}
						pi.events.on("mutate", () => { ${laterMutation} });
						pi.events.emit("loaded-api", { api: pi, marker: ${JSON.stringify(expectedMarker)} });
					}`;
				if (scenario === "post-finalization-content") writeFileSync(approvedFile, mutableModule);
				else writeFileSync(outsideFile, mutableModule);
				writeFileSync(
					join(agentDir, "settings.json"),
					JSON.stringify({
						packages: [source],
						turnProvenance: { voiceExtensions: [allowed], fabricExtensions: [allowed] },
					}),
				);
				const settings = SettingsManager.create(cwd, agentDir);
				let api!: ExtensionAPI;
				let marker: string | undefined;
				const eventBus = createEventBus();
				eventBus.on("loaded-api", (value) => {
					({ api, marker } = value as { api: ExtensionAPI; marker: string });
				});
				const loader = new DefaultResourceLoader({
					cwd,
					agentDir,
					settingsManager: settings,
					eventBus,
					noContextFiles: true,
				});
				await loader.reload(scenario === "unicode-preload" ? { resolveProjectTrust: async () => true } : undefined);
				expect(loader.getExtensions().errors).toEqual([]);
				expect(loader.getExtensions().extensions).toHaveLength(1);
				expect.soft(marker).toBe(expectedMarker);
				const harness = await createHarness({
					persistSession: true,
					resourceLoader: loader,
					settings: settings.getGlobalSettings(),
				});
				harnesses.push(harness);
				await harness.session.bindExtensions({});
				eventBus.emit("mutate", undefined);
				harness.setResponses([fauxAssistantMessage("done")]);
				api.sendMessage({ customType: "loaded-claim", content: "custom", display: false }, { provenance: claim });
				api.sendUserMessage("user", { provenance: claim });
				await vi.waitFor(() =>
					expect(harness.sessionManager.getEntries().filter((entry) => getTurnProvenance(entry))).toHaveLength(2),
				);
				await harness.session.agent.waitForIdle();
				const entries = harness.sessionManager.getEntries().filter((entry) => getTurnProvenance(entry));
				const records = entries.map(getTurnProvenance);
				const channels = trusted ? [claim.channel, claim.channel] : ["terminal", "terminal"];
				expect(entries.map((entry) => entry.type)).toEqual(["custom_message", "message"]);
				expect.soft(records.map((record) => record?.channel)).toEqual(channels);
				for (const record of records) {
					if (!trusted) {
						expect.soft(record?.principal).toBeUndefined();
						expect.soft(record?.sender).toBeUndefined();
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
				const reopenedRecords = reopened
					.getEntries()
					.filter((entry) => getTurnProvenance(entry))
					.map(getTurnProvenance);
				expect(reopenedRecords).toEqual(records);
				expect.soft(reopenedRecords.map((record) => record?.channel)).toEqual(channels);
				expect(
					reopened
						.buildSessionContext()
						.messages.filter((message) => message.role === "user" || message.role === "custom"),
				).toHaveLength(2);
			});
		}
	}
});
