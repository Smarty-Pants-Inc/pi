// pi#95 R7: a shared Git cache must not grant a requested ref's authority to another ref's code.
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

describe("pi#95 cached Git ref attribution", () => {
	for (const ingress of ["global-packages", "additionalExtensionPaths"] as const) {
		for (const claim of claims) {
			it(`${ingress}: ${claim.channel} checks executed ref, both sends, JSONL and reopen`, async () => {
				const root = mkdtempSync(join(tmpdir(), "pi-95-git-ref-"));
				directories.push(root);
				const repo = join(root, "repo");
				const cwd = join(root, "project");
				const agentDir = join(root, "agent");
				for (const dir of [join(repo, "extensions"), cwd, agentDir]) mkdirSync(dir, { recursive: true });
				const git = (...args: string[]) =>
					execFileSync("git", args, {
						cwd: repo,
						encoding: "utf8",
						// Fixture commits must also work on CI without a configured Git identity.
						env: {
							...process.env,
							GIT_AUTHOR_NAME: "Provenance fixture",
							GIT_AUTHOR_EMAIL: "fixture@example.invalid",
							GIT_COMMITTER_NAME: "Provenance fixture",
							GIT_COMMITTER_EMAIL: "fixture@example.invalid",
						},
					}).trim();
				git("init", "--initial-branch=unapproved");
				const extension = (marker: string) => `export default function(pi) {
					pi.events.emit("loaded-api", { api: pi, marker: ${JSON.stringify(marker)} });
				}`;
				writeFileSync(join(repo, "extensions", "index.ts"), extension("unapproved"));
				git("add", "extensions/index.ts");
				git("commit", "-m", "unapproved fixture");
				const unapprovedHead = git("rev-parse", "HEAD");
				git("checkout", "-b", "approved");
				writeFileSync(join(repo, "extensions", "index.ts"), extension("approved"));
				git("add", "extensions/index.ts");
				git("commit", "-m", "approved fixture");
				const approvedHead = git("rev-parse", "HEAD");
				git("tag", "-a", "approved-tag", "-m", "annotated approval");
				expect(approvedHead).not.toBe(unapprovedHead);
				git("checkout", "unapproved");
				// Real Git commands and a file transport, without a network dependency or subprocess mocks.
				const url = "https://provenance.invalid/fixture/voice";
				vi.stubEnv("GIT_CONFIG_COUNT", "1");
				vi.stubEnv("GIT_CONFIG_KEY_0", `url.${pathToFileURL(repo).href}.insteadOf`);
				vi.stubEnv("GIT_CONFIG_VALUE_0", url);
				let cachedRoot: string | undefined;
				for (const phase of [
					"unapproved",
					"approved",
					"unknown-ref",
					"missing-git",
					"matched",
					"matched-tag",
					"matched-commit",
				] as const) {
					const matched = phase.startsWith("matched");
					vi.stubEnv("PI_OFFLINE", phase === "unknown-ref" || phase === "missing-git" ? "1" : "0");
					const profile = matched ? join(root, phase) : agentDir;
					mkdirSync(profile, { recursive: true });
					if (phase === "missing-git") rmSync(join(cachedRoot!, ".git"), { recursive: true });
					const ref =
						phase === "matched-tag"
							? "approved-tag"
							: phase === "matched-commit"
								? approvedHead
								: phase === "missing-git" || matched
									? "approved"
									: phase;
					const source = `git:${url}@${ref}`;
					const allowed = phase === "unknown-ref" || matched ? source : `git:${url}@approved`;
					writeFileSync(
						join(profile, "settings.json"),
						JSON.stringify({
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
					cachedRoot = loader.getExtensions().extensions[0].sourceInfo.baseDir;
					expect(marker).toBe(matched ? "approved" : "unapproved");
					if (phase !== "missing-git") {
						expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: cachedRoot, encoding: "utf8" }).trim()).toBe(
							matched ? approvedHead : unapprovedHead,
						);
					}
					const harness = await createHarness({
						persistSession: true,
						resourceLoader: loader,
						settings: settings.getGlobalSettings(),
					});
					harnesses.push(harness);
					await harness.session.bindExtensions({});
					harness.setResponses([fauxAssistantMessage("done")]);
					api.sendMessage({ customType: "git-claim", content: marker!, display: false }, { provenance: claim });
					api.sendUserMessage(marker!, { provenance: claim });
					await vi.waitFor(() =>
						expect(harness.sessionManager.getEntries().filter((entry) => getTurnProvenance(entry))).toHaveLength(
							2,
						),
					);
					await harness.session.agent.waitForIdle();
					const entries = harness.sessionManager.getEntries().filter((entry) => getTurnProvenance(entry));
					const records = entries.map(getTurnProvenance);
					const channels = matched ? [claim.channel, claim.channel] : ["terminal", "terminal"];
					expect(entries.map((entry) => entry.type)).toEqual(["custom_message", "message"]);
					expect
						.soft(
							records.map((record) => record?.channel),
							phase,
						)
						.toEqual(channels);
					for (const record of records) {
						if (!matched) {
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
