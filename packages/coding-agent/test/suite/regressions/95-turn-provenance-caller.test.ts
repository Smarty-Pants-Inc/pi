// pi#95 R2: inspection metadata must not be an extension's provenance admission anchor.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import type { SourceInfo } from "../../../src/core/source-info.ts";
import { getTurnProvenance, type TurnProvenanceClaim } from "../../../src/core/turn-provenance.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

const TRUSTED = "npm:trusted-provenance@1.0.0";
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

async function fixture(scope: SourceInfo["scope"], trusted: boolean) {
	let api!: ExtensionAPI;
	const result = await createTestExtensionsResult([
		{
			name: "caller",
			factory: (pi) => {
				api = pi;
				pi.registerCommand("inspect-caller", { handler: async () => {} });
				pi.registerTool({
					name: "inspect_caller",
					label: "Inspect",
					description: "Fixture",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				});
			},
		},
	]);
	const extension = result.extensions[0];
	// A custom resource loader assigns authoritative metadata before the runner is constructed.
	const sourceInfo: SourceInfo = {
		path: extension.path,
		source: trusted ? TRUSTED : "npm:untrusted@1.0.0",
		scope,
		origin: trusted ? "package" : "top-level",
	};
	extension.sourceInfo = sourceInfo;
	for (const command of extension.commands.values()) command.sourceInfo = sourceInfo;
	for (const tool of extension.tools.values()) tool.sourceInfo = sourceInfo;
	const harness = await createHarness({
		resourceLoader: createTestResourceLoader({ extensionsResult: result }),
		settings: { turnProvenance: { voiceExtensions: [TRUSTED], fabricExtensions: [TRUSTED] } },
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	return { api, harness, extension, original: { ...sourceInfo } };
}

async function deliver(api: ExtensionAPI, harness: Harness, claim: TurnProvenanceClaim) {
	harness.setResponses([fauxAssistantMessage("done")]);
	const count = harness.sessionManager.getEntries().filter((entry) => getTurnProvenance(entry)).length;
	api.sendMessage({ customType: "claim", content: "custom", display: false }, { provenance: claim });
	api.sendUserMessage("user", { provenance: claim });
	await vi.waitFor(() => {
		expect(harness.sessionManager.getEntries().filter((entry) => getTurnProvenance(entry))).toHaveLength(count + 2);
	});
	await harness.session.agent.waitForIdle();
	return harness.sessionManager
		.getEntries()
		.flatMap((entry) => {
			const provenance = getTurnProvenance(entry);
			return provenance ? [provenance.channel] : [];
		})
		.slice(-2);
}

function inspect(api: ExtensionAPI, kind: "commands" | "tools") {
	return kind === "commands"
		? api.getCommands().find((command) => command.name === "inspect-caller")!.sourceInfo!
		: api.getAllTools().find((tool) => tool.name === "inspect_caller")!.sourceInfo;
}

describe("pi#95 immutable caller admission", () => {
	for (const kind of ["commands", "tools"] as const) {
		for (const scope of ["user", "project"] as const) {
			for (const allowlisted of scope === "project" ? [false, true] : [false]) {
				for (const claim of claims) {
					it(`refuses ${claim.channel} after ${kind} metadata forgery by ${scope} extension (allowlisted=${allowlisted})`, async () => {
						const { api, harness, original } = await fixture(scope, allowlisted);
						Object.assign(inspect(api, kind), { scope: "user", source: TRUSTED, origin: "package" });
						expect(await deliver(api, harness, claim)).toEqual(["terminal", "terminal"]);
						expect(inspect(api, kind)).toEqual(original);
					});
				}
			}
		}
		for (const claim of claims) {
			it(`keeps legitimate ${claim.channel} package trust after ${kind} metadata mutation`, async () => {
				const { api, harness, original, extension } = await fixture("user", true);
				Object.assign(inspect(api, kind), { scope: "project", source: "untrusted", origin: "top-level" });
				expect(await deliver(api, harness, claim)).toEqual([claim.channel, claim.channel]);
				expect(inspect(api, kind)).toEqual(original);
				// Even host inspection of the Extension object is not the private admission descriptor.
				Object.assign(extension.sourceInfo, { scope: "project", source: "untrusted", origin: "top-level" });
				expect(await deliver(api, harness, claim)).toEqual([claim.channel, claim.channel]);
			});
		}
	}
});

describe("pi#95 CLI-only package provenance", () => {
	for (const projectDuplicate of [false, true]) {
		it(`preserves CLI package identity and ${projectDuplicate ? "rejects project overlap" : "temporary trust"}`, async () => {
			const root = mkdtempSync(join(tmpdir(), "pi-95-package-"));
			directories.push(root);
			const cwd = join(root, "project");
			const agentDir = join(root, "agent");
			const packageRoot = join(root, "package");
			for (const dir of [cwd, agentDir, packageRoot]) mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(packageRoot, "package.json"),
				JSON.stringify({ name: "trust-fixture", pi: { extensions: ["index.ts"] } }),
			);
			writeFileSync(
				join(packageRoot, "index.ts"),
				`export default function(pi) {
				pi.registerCommand("claim-voice", { handler: async () => pi.sendMessage({ customType: "cli-claim", content: "voice", display: false }, { provenance: { channel: "voice", principal: { id: "paul" } } }) });
				pi.registerCommand("claim-fabric", { handler: async () => pi.sendMessage({ customType: "cli-claim", content: "fabric", display: false }, { provenance: { channel: "fabric", sender: { id: "session:org", kind: "main", verified: "mesh" } } }) });
			}`,
			);
			if (projectDuplicate) {
				mkdirSync(join(cwd, ".pi"));
				writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: [packageRoot] }));
			}
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: SettingsManager.create(cwd, agentDir),
				additionalExtensionPaths: [packageRoot],
				noExtensions: true,
				noContextFiles: true,
			});
			await loader.reload();
			expect(loader.getExtensions().errors).toEqual([]);
			expect(loader.getExtensions().extensions).toHaveLength(1);
			const harness = await createHarness({
				resourceLoader: loader,
				settings: { turnProvenance: { voiceExtensions: [packageRoot], fabricExtensions: [packageRoot] } },
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({});
			await harness.session.prompt("/claim-voice");
			await harness.session.prompt("/claim-fabric");
			await vi.waitFor(() =>
				expect(harness.sessionManager.getEntries().filter((entry) => getTurnProvenance(entry))).toHaveLength(2),
			);
			expect(
				harness.sessionManager.getEntries().flatMap((entry) => {
					const provenance = getTurnProvenance(entry);
					return provenance ? [provenance.channel] : [];
				}),
			).toEqual(projectDuplicate ? ["terminal", "terminal"] : ["voice", "fabric"]);
			expect(loader.getExtensions().extensions[0].sourceInfo).toMatchObject({
				source: packageRoot,
				origin: "package",
				scope: projectDuplicate ? "project" : "temporary",
			});
		});
	}
});
