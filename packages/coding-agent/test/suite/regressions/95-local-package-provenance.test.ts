// pi#95 R5: local package spellings must not bypass channel trust through the real loader or journal.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
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

const cases = [
	"traversal-file",
	"traversal-package",
	"relative-traversal-file",
	"relative-traversal-package",
	"symlink-file-escape",
	"symlink-package-escape",
	"sibling-prefix",
	"normalized-file",
	"normalized-package",
	"normalized-directory",
	"relative-package",
	"allowlist-symlink",
	"source-symlink",
	"case",
	"file-url",
] as const;

describe("pi#95 local package identity and persisted attribution", () => {
	for (const ingress of ["global-packages", "additionalExtensionPaths"] as const) {
		for (const scenario of cases) {
			for (const claim of claims) {
				it(`${ingress}: ${scenario} ${claim.channel} survives real loading and reopen`, async () => {
					const root = mkdtempSync(join(tmpdir(), "pi-95-local-package-"));
					directories.push(root);
					const cwd = join(root, "project", "nested");
					const agentDir = join(root, "agent");
					const approved = join(root, "approved");
					const approvedPackage = join(approved, "package");
					const unapprovedPackage = join(root, "unapproved");
					const siblingPackage = join(root, "approved-other");
					const extension = `export default function(pi) { pi.events.emit("loaded-api", pi); }`;
					for (const dir of [cwd, agentDir, approvedPackage, unapprovedPackage, siblingPackage]) {
						mkdirSync(dir, { recursive: true });
					}
					for (const dir of [approvedPackage, unapprovedPackage, siblingPackage]) {
						writeFileSync(join(dir, "package.json"), JSON.stringify({ pi: { extensions: ["index.ts"] } }));
						writeFileSync(join(dir, "index.ts"), extension);
					}
					const approvedFile = join(approved, "caller.ts");
					const unapprovedFile = join(root, "unapproved.ts");
					writeFileSync(approvedFile, extension);
					writeFileSync(unapprovedFile, extension);
					symlinkSync(unapprovedFile, join(approved, "linked.ts"), "file");
					symlinkSync(unapprovedPackage, join(approved, "linked-package"), "junction");
					const alias = join(root, "approved-alias");
					symlinkSync(approvedPackage, alias, "junction");
					const baseDir = ingress === "global-packages" ? agentDir : cwd;
					let source: string;
					let allowed = `${approved}/`;
					let trusted = false;
					switch (scenario) {
						case "traversal-file":
							source = `${approved}/../unapproved.ts`;
							break;
						case "traversal-package":
							source = `${approved}/../unapproved`;
							break;
						case "relative-traversal-file":
							source = `${relative(baseDir, approved)}/../unapproved.ts`;
							break;
						case "relative-traversal-package":
							source = `${relative(baseDir, approved)}/../unapproved`;
							break;
						case "symlink-file-escape":
							source = join(approved, "linked.ts");
							break;
						case "symlink-package-escape":
							source = join(approved, "linked-package");
							break;
						case "sibling-prefix":
							source = siblingPackage;
							break;
						case "normalized-file":
							source = `${approved}/../approved/caller.ts`;
							allowed = approvedFile;
							trusted = true;
							break;
						case "normalized-package":
							source = `${approved}/../approved/package`;
							allowed = approvedPackage;
							trusted = true;
							break;
						case "normalized-directory":
							source = `${approved}/../approved/package`;
							trusted = true;
							break;
						case "relative-package":
							source = relative(baseDir, approvedPackage);
							allowed = approvedPackage;
							trusted = true;
							break;
						case "allowlist-symlink":
							source = approvedPackage;
							allowed = alias;
							trusted = true;
							break;
						case "source-symlink":
							source = alias;
							allowed = approvedPackage;
							trusted = true;
							break;
						case "file-url":
							source = pathToFileURL(approvedFile).href;
							allowed = approvedFile;
							trusted = true;
							break;
						case "case": {
							const otherCase = join(root, "APPROVED");
							trusted = existsSync(otherCase);
							mkdirSync(otherCase, { recursive: true });
							writeFileSync(join(otherCase, "caller.ts"), extension);
							source = join(otherCase, "caller.ts");
							break;
						}
					}
					writeFileSync(
						join(agentDir, "settings.json"),
						JSON.stringify({
							...(ingress === "global-packages" ? { packages: [source] } : {}),
							turnProvenance: { voiceExtensions: [allowed], fabricExtensions: [allowed] },
						}),
					);
					const settings = SettingsManager.create(cwd, agentDir);
					let api!: ExtensionAPI;
					const eventBus = createEventBus();
					eventBus.on("loaded-api", (value) => {
						api = value as ExtensionAPI;
					});
					const loader = new DefaultResourceLoader({
						cwd,
						agentDir,
						settingsManager: settings,
						eventBus,
						noContextFiles: true,
						additionalExtensionPaths: ingress === "additionalExtensionPaths" ? [source] : [],
					});
					await loader.reload();
					expect(loader.getExtensions().errors).toEqual([]);
					expect(loader.getExtensions().extensions).toHaveLength(1);
					expect(loader.getExtensions().extensions[0].sourceInfo).toMatchObject({
						source,
						origin: "package",
						scope: ingress === "global-packages" ? "user" : "temporary",
					});
					const harness = await createHarness({
						persistSession: true,
						resourceLoader: loader,
						settings: settings.getGlobalSettings(),
					});
					harnesses.push(harness);
					await harness.session.bindExtensions({});
					harness.setResponses([fauxAssistantMessage("done")]);
					api.sendMessage({ customType: "local-claim", content: "custom", display: false }, { provenance: claim });
					api.sendUserMessage("user", { provenance: claim });
					await vi.waitFor(() =>
						expect(harness.sessionManager.getEntries().filter((entry) => getTurnProvenance(entry))).toHaveLength(
							2,
						),
					);
					await harness.session.agent.waitForIdle();
					const entries = harness.sessionManager.getEntries().filter((entry) => getTurnProvenance(entry));
					const records = entries.map(getTurnProvenance);
					expect(entries.map((entry) => entry.type)).toEqual(["custom_message", "message"]);
					const expectedChannels = trusted ? [claim.channel, claim.channel] : ["terminal", "terminal"];
					expect.soft(records.map((record) => record?.channel)).toEqual(expectedChannels);
					for (const record of records) {
						if (!trusted) {
							expect.soft(record?.principal).toBeUndefined();
							expect.soft(record?.sender).toBeUndefined();
						} else if (claim.channel === "voice") {
							expect.soft(record?.principal).toEqual({ id: "paul", binding: "voice-call" });
						} else {
							expect.soft(record?.sender).toEqual(claim.sender);
							expect.soft(record?.via).toBe("steer");
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
					expect.soft(reopenedRecords.map((record) => record?.channel)).toEqual(expectedChannels);
					expect(
						reopened
							.buildSessionContext()
							.messages.filter((message) => message.role === "user" || message.role === "custom"),
					).toHaveLength(2);
				});
			}
		}
	}
});
