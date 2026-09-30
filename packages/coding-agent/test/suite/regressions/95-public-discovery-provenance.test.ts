// pi#95 R2: public discovery must not promote automatic project extensions to temporary trust.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadExtensions } from "../../../src/core/extensions/loader.ts";
import { type SessionEntry, SessionManager } from "../../../src/core/session-manager.ts";
import {
	getExtensionTurnProvenanceCaller,
	getTurnProvenance,
	type TurnProvenanceClaim,
} from "../../../src/core/turn-provenance.ts";
import { createEventBus, discoverAndLoadExtensions, type ExtensionAPI } from "../../../src/index.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
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

const modes = ["project", "project-explicit-duplicate", "user", "configured", "raw-cli", "inline"] as const;

describe("pi#95 public discovery with custom ResourceLoader", () => {
	for (const mode of modes) {
		for (const claim of claims) {
			it(`${mode}: persists both send APIs with ${claim.channel} admission`, async () => {
				const root = mkdtempSync(join(tmpdir(), "pi-95-public-discovery-"));
				directories.push(root);
				const cwd = join(root, "project");
				const agentDir = join(root, "agent");
				const project = mode === "project" || mode === "project-explicit-duplicate";
				const extensionPath =
					project || mode === "raw-cli"
						? join(cwd, ".pi", "extensions", "caller.ts")
						: mode === "user"
							? join(agentDir, "extensions", "caller.ts")
							: join(root, "explicit", "caller.ts");
				mkdirSync(cwd, { recursive: true });
				mkdirSync(agentDir, { recursive: true });
				mkdirSync(dirname(extensionPath), { recursive: true });
				writeFileSync(
					extensionPath,
					`export default function(pi) {
					pi.registerCommand("inspect-caller", { handler: async () => {} });
					pi.registerTool({ name: "inspect_caller", label: "Inspect", description: "Fixture",
						parameters: { type: "object", properties: {} },
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) });
					pi.events.emit("loaded-api", pi);
				}`,
				);
				let api!: ExtensionAPI;
				const eventBus = createEventBus();
				eventBus.on("loaded-api", (value) => {
					api = value as ExtensionAPI;
				});
				const result =
					mode === "inline"
						? await createTestExtensionsResult(
								[
									{
										name: "intentional-temporary",
										factory: (pi) => {
											api = pi;
										},
									},
								],
								cwd,
							)
						: mode === "raw-cli"
							? await loadExtensions([extensionPath], cwd, eventBus)
							: await discoverAndLoadExtensions(
									mode === "configured" || mode === "project-explicit-duplicate" ? [extensionPath] : [],
									cwd,
									agentDir,
									eventBus,
								);
				expect(result.errors).toEqual([]);
				expect(result.extensions).toHaveLength(1);
				const extension = result.extensions[0];
				expect(getExtensionTurnProvenanceCaller(extension)).toBeUndefined();
				const harness = await createHarness({
					persistSession: true,
					// Ordinary public host composition: return discovery's result without metadata repair.
					resourceLoader: createTestResourceLoader({ extensionsResult: result }),
					settings: {
						turnProvenance: {
							voiceExtensions: [extension.resolvedPath],
							fabricExtensions: [extension.resolvedPath],
						},
					},
				});
				harnesses.push(harness);
				await harness.session.bindExtensions({});
				harness.setResponses([fauxAssistantMessage("done")]);
				api.sendMessage(
					{ customType: "discovery-claim", content: "custom", display: false },
					{ provenance: claim },
				);
				api.sendUserMessage("user", { provenance: claim });
				await vi.waitFor(() => {
					expect(harness.sessionManager.getEntries().filter((entry) => getTurnProvenance(entry))).toHaveLength(2);
				});
				await harness.session.agent.waitForIdle();
				const entries = harness.sessionManager.getEntries().filter((entry) => getTurnProvenance(entry));
				const records = entries.map(getTurnProvenance);
				expect(entries.map((entry) => entry.type)).toEqual(["custom_message", "message"]);
				expect(records.map((record) => record?.channel)).toEqual(
					project ? ["terminal", "terminal"] : [claim.channel, claim.channel],
				);
				expect(records[0]?.turnId).not.toBe(records[1]?.turnId);
				const file = harness.sessionManager.getSessionFile()!;
				const reopened = SessionManager.open(file, harness.tempDir)
					.getEntries()
					.filter((entry) => getTurnProvenance(entry));
				expect(reopened.map(getTurnProvenance)).toEqual(records);
				const jsonl = readFileSync(file, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as SessionEntry);
				expect(jsonl.filter((entry) => getTurnProvenance(entry)).map(getTurnProvenance)).toEqual(records);
				const scope = project ? "project" : mode === "user" ? "user" : "temporary";
				expect(extension.sourceInfo.scope).toBe(scope);
				const descriptor = getExtensionTurnProvenanceCaller(extension)!;
				expect(descriptor.sourceInfo.scope).toBe(scope);
				expect(Object.isFrozen(descriptor)).toBe(true);
				expect(Object.isFrozen(descriptor.sourceInfo)).toBe(true);
				if (mode !== "inline") {
					expect(api.getCommands().find((command) => command.name === "inspect-caller")?.sourceInfo).toEqual(
						extension.sourceInfo,
					);
					expect(api.getAllTools().find((tool) => tool.name === "inspect_caller")?.sourceInfo).toEqual(
						extension.sourceInfo,
					);
				}
				Object.assign(extension.sourceInfo, { scope: project ? "user" : "project" });
				expect(descriptor.sourceInfo.scope).toBe(scope);
			});
		}
	}
});
