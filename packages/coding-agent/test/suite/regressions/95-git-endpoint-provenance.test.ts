// pi#95 R7: local ref equality in a colliding cache cannot establish another Git endpoint's authority.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	vi.unstubAllEnvs();
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Provenance fixture",
			GIT_AUTHOR_EMAIL: "fixture@example.invalid",
			GIT_COMMITTER_NAME: "Provenance fixture",
			GIT_COMMITTER_EMAIL: "fixture@example.invalid",
		},
	}).trim();
}

describe("pi#95 cached Git endpoint attribution", () => {
	for (const ingress of ["global-packages", "additionalExtensionPaths"] as const) {
		for (const claim of claims) {
			it(`${ingress}: ${claim.channel} checks installed endpoint, both sends, JSONL and reopen`, async () => {
				const root = mkdtempSync(join(tmpdir(), "pi-95-git-endpoint-"));
				directories.push(root);
				const cwd = join(root, "project");
				const agentDir = join(root, "agent");
				mkdirSync(cwd);
				const urls = ["git://127.0.0.1:19418/fixture/voice", "git://127.0.0.1:19419/fixture/voice"];
				const heads = urls.map((url, index) => {
					const repo = join(root, `repo-${index}`);
					const bare = join(root, `bare-${index}`);
					mkdirSync(join(repo, "extensions"), { recursive: true });
					git(repo, "init", "--initial-branch=approved");
					writeFileSync(
						join(repo, "extensions", "index.ts"),
						`export default function(pi) { pi.events.emit("loaded-api", { api: pi, marker: ${index} }); }`,
					);
					git(repo, "add", "extensions/index.ts");
					git(repo, "commit", "-m", `endpoint ${index}`);
					git(root, "clone", "--bare", repo, bare);
					// Real Git subprocesses; only transport is redirected to local bare repositories.
					vi.stubEnv(`GIT_CONFIG_KEY_${index}`, `url.${pathToFileURL(bare).href}.insteadOf`);
					vi.stubEnv(`GIT_CONFIG_VALUE_${index}`, url);
					return git(repo, "rev-parse", "HEAD");
				});
				vi.stubEnv("GIT_CONFIG_COUNT", "2");
				expect(heads[0]).not.toBe(heads[1]);
				const sources = urls.map((url) => `git:${url}@approved`);
				let cachedRoot: string | undefined;
				for (const phase of [
					"a",
					"b",
					"offline-b",
					"normalized-origin",
					"wrong-protocol",
					"wrong-path",
					"missing-origin",
					"ambiguous-origin",
					"ambiguous-empty-origin",
					"invalid-origin",
					"matched-a",
					"matched-b",
					"file-grant",
				] as const) {
					const matched = phase.startsWith("matched");
					const admitted = matched || phase === "normalized-origin" || phase === "file-grant";
					const index = phase === "a" || phase === "matched-a" || phase === "normalized-origin" ? 0 : 1;
					const profile = matched ? join(root, phase) : agentDir;
					mkdirSync(profile, { recursive: true });
					vi.stubEnv("PI_OFFLINE", phase === "offline-b" ? "1" : "0");
					if (phase === "normalized-origin")
						git(
							cachedRoot!,
							"config",
							"--local",
							"--replace-all",
							"remote.origin.url",
							urls[0].replace("git:", "GIT:"),
						);
					if (phase === "wrong-protocol")
						git(
							cachedRoot!,
							"config",
							"--local",
							"--replace-all",
							"remote.origin.url",
							urls[1].replace("git:", "ssh:"),
						);
					if (phase === "wrong-path")
						git(
							cachedRoot!,
							"config",
							"--local",
							"--replace-all",
							"remote.origin.url",
							urls[1].replace("/voice", "/other"),
						);
					if (phase === "missing-origin")
						git(cachedRoot!, "config", "--local", "--unset-all", "remote.origin.url");
					if (phase === "ambiguous-origin") {
						git(cachedRoot!, "config", "--local", "--add", "remote.origin.url", urls[1]);
						git(cachedRoot!, "config", "--local", "--add", "remote.origin.url", urls[0]);
					}
					if (phase === "ambiguous-empty-origin") {
						git(cachedRoot!, "config", "--local", "--replace-all", "remote.origin.url", urls[1]);
						git(cachedRoot!, "config", "--local", "--add", "remote.origin.url", "");
					}
					if (phase === "invalid-origin")
						git(cachedRoot!, "config", "--local", "--replace-all", "remote.origin.url", "not-a-git-endpoint");
					const allowed =
						phase === "file-grant"
							? join(cachedRoot!, "extensions", "index.ts")
							: matched || phase === "normalized-origin"
								? sources[index]
								: sources[1];
					writeFileSync(
						join(profile, "settings.json"),
						JSON.stringify({
							...(ingress === "global-packages" ? { packages: [sources[index]] } : {}),
							turnProvenance: { voiceExtensions: [allowed], fabricExtensions: [allowed] },
						}),
					);
					const settings = SettingsManager.create(cwd, profile);
					let api!: ExtensionAPI;
					let marker: number | undefined;
					const eventBus = createEventBus();
					eventBus.on("loaded-api", (value) => {
						({ api, marker } = value as { api: ExtensionAPI; marker: number });
					});
					const loader = new DefaultResourceLoader({
						cwd,
						agentDir: profile,
						settingsManager: settings,
						eventBus,
						noContextFiles: true,
						additionalExtensionPaths: ingress === "additionalExtensionPaths" ? [sources[index]] : [],
					});
					await loader.reload();
					expect(loader.getExtensions().errors, phase).toEqual([]);
					expect(loader.getExtensions().extensions, phase).toHaveLength(1);
					const installedRoot = loader.getExtensions().extensions[0].sourceInfo.baseDir!;
					if (!matched && phase !== "a") expect(installedRoot, phase).toBe(cachedRoot);
					if (phase === "a") cachedRoot = installedRoot;
					expect(marker, phase).toBe(matched ? index : 0);
					// The old ref-only guard passes in every phase, even when the installed endpoint is wrong.
					expect(git(installedRoot, "rev-parse", "HEAD^{commit}"), phase).toBe(heads[matched ? index : 0]);
					expect(git(installedRoot, "rev-parse", "approved^{commit}"), phase).toBe(heads[matched ? index : 0]);
					const harness = await createHarness({
						persistSession: true,
						resourceLoader: loader,
						settings: settings.getGlobalSettings(),
					});
					harnesses.push(harness);
					await harness.session.bindExtensions({});
					harness.setResponses([fauxAssistantMessage("done")]);
					api.sendMessage(
						{ customType: "git-endpoint-claim", content: String(marker), display: false },
						{ provenance: claim },
					);
					api.sendUserMessage(String(marker), { provenance: claim });
					await vi.waitFor(() =>
						expect(harness.sessionManager.getEntries().filter((entry) => getTurnProvenance(entry))).toHaveLength(
							2,
						),
					);
					await harness.session.agent.waitForIdle();
					const entries = harness.sessionManager.getEntries().filter((entry) => getTurnProvenance(entry));
					const records = entries.map(getTurnProvenance);
					expect(entries.map((entry) => entry.type)).toEqual(["custom_message", "message"]);
					expect
						.soft(
							records.map((record) => record?.channel),
							phase,
						)
						.toEqual(admitted ? [claim.channel, claim.channel] : ["terminal", "terminal"]);
					for (const record of records) {
						if (!admitted) {
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
			}, 30_000);
		}
	}
});
