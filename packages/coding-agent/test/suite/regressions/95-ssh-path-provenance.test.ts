// pi#95 R8 finding 2: SSH path shortening must not associate a cached repository with another source grant.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../../../src/core/event-bus.ts";
import { clearExtensionCache } from "../../../src/core/extensions/loader.ts";
import { normalizeGitEndpoint } from "../../../src/core/extensions/module-identity.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { type SessionEntry, SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { getTurnProvenance, type TurnProvenanceClaim } from "../../../src/core/turn-provenance.ts";
import { parseGitUrl } from "../../../src/utils/git.ts";
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
	clearExtensionCache();
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		timeout: 10_000,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Provenance fixture",
			GIT_AUTHOR_EMAIL: "fixture@example.invalid",
			GIT_COMMITTER_NAME: "Provenance fixture",
			GIT_COMMITTER_EMAIL: "fixture@example.invalid",
		},
	}).trim();
}

async function receipt(
	harness: Harness,
	api: ExtensionAPI,
	claim: TurnProvenanceClaim,
	admitted: boolean,
	label: string,
) {
	harness.setResponses([fauxAssistantMessage("done")]);
	api.sendMessage({ customType: "ssh-path-claim", content: label, display: false }, { provenance: claim });
	api.sendUserMessage(label, { provenance: claim });
	await vi.waitFor(() =>
		expect(harness.sessionManager.getEntries().filter((entry) => getTurnProvenance(entry))).toHaveLength(2),
	);
	await harness.session.agent.waitForIdle();
	const entries = harness.sessionManager.getEntries().filter((entry) => getTurnProvenance(entry));
	const records = entries.map(getTurnProvenance);
	expect(entries.map((entry) => entry.type)).toEqual(["custom_message", "message"]);
	expect
		.soft(
			records.map((record) => record?.channel),
			label,
		)
		.toEqual(admitted ? [claim.channel, claim.channel] : ["terminal", "terminal"]);
	for (const record of records) {
		if (!admitted) {
			expect.soft(record?.principal, label).toBeUndefined();
			expect.soft(record?.sender, label).toBeUndefined();
			expect.soft(record?.via, label).toBeUndefined();
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
	expect(jsonl.filter((entry) => getTurnProvenance(entry))).toEqual(entries);
	const reopened = SessionManager.open(file, harness.tempDir);
	expect(reopened.getEntries().filter((entry) => getTurnProvenance(entry))).toEqual(entries);
	expect(
		reopened.buildSessionContext().messages.filter((message) => message.role === "user" || message.role === "custom"),
	).toHaveLength(2);
}

describe("pi#95 SSH endpoint association", () => {
	it.each([
		"/fixture/./voice",
		"/fixture/link/../voice",
		"/fixture/%2e/voice",
		"/fixture/link/%2e%2e/voice",
		"/fixture/link/%2E%2E/voice",
		"/fixture/link/.%2e/voice",
		"/fixture/link/%2e./voice",
		"/fixture/link/%252e%252e/voice",
		"/fixture/link\\..\\voice",
		"/fixture/link/%2f../voice",
		"/fixture/link/%2F../voice",
		"/fixture/link/%5c../voice",
		"/fixture/link/%5C../voice",
		"/fixture/link/%255c../voice",
		"/fixture/link/%c0%ae%c0%ae/voice",
		"/fixture/link/%u002e%u002e/voice",
		"/fixture/link/%/voice",
		"/fixture/voïce",
		"/fixture/voice?other",
		"/fixture/voice#other",
	])("refuses ambiguous raw explicit SSH path %s for authority", (path) => {
		expect(normalizeGitEndpoint(`ssh://git@fixture.invalid:2222${path}`)).toBeUndefined();
	});

	it.each([
		["ssh://git@fixture.invalid:2222/fixture/voice.git", "ssh://git@fixture.invalid:2222/fixture/voice.git"],
		["SSH://git@fixture.invalid:2222/fixture/voice.git", "ssh://git@fixture.invalid:2222/fixture/voice.git"],
		["ssh://git@[::1]:2222/fixture/.voice-1_~.git", "ssh://git@[::1]:2222/fixture/.voice-1_~.git"],
		["git@fixture.invalid:fixture/voice.git", "git@fixture.invalid:fixture/voice.git"],
		["GIT://fixture.invalid:9418/fixture/voice", "git://fixture.invalid:9418/fixture/voice"],
		["https://fixture.invalid/fixture/voice.git", "https://fixture.invalid/fixture/voice.git"],
		["ssh://git@fixture.invalid/fixture/Voice.git", "ssh://git@fixture.invalid/fixture/Voice.git"],
	])("retains safe matching endpoint %s", (endpoint, expected) => {
		expect(normalizeGitEndpoint(endpoint)).toBe(expected);
	});

	it.each(["\0ssh://git@fixture.invalid/fixture/link/../voice", "ssh://git@fixture.invalid/fixture/vo\0ice"])(
		"refuses URL-trimmable control characters in %j",
		(endpoint) => expect(normalizeGitEndpoint(endpoint)).toBeUndefined(),
	);

	// The fixture models a POSIX SSH service, not a URI-decoding service or native-module verification.
	for (const path of ["/fixture/link/../voice", "/fixture/link/%2e%2e/voice"]) {
		for (const ingress of ["global-packages", "additionalExtensionPaths"] as const) {
			for (const claim of claims) {
				it.skipIf(process.platform === "win32")(
					`${path}: ${ingress} ${claim.channel} A→B cache reuse, file trust and matching controls`,
					async () => {
						clearExtensionCache();
						const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pi-95-ssh-path-")));
						directories.push(root);
						const cwd = join(root, "project");
						const agentDir = join(root, "agent");
						const transportRoot = join(root, "transport");
						mkdirSync(cwd);
						mkdirSync(join(transportRoot, "fixture"), { recursive: true });
						mkdirSync(join(transportRoot, "elsewhere", "leaf"), { recursive: true });
						symlinkSync(join(transportRoot, "elsewhere", "leaf"), join(transportRoot, "fixture", "link"), "dir");
						const heads = ["A", "B"].map((marker, index) => {
							const repo = join(root, `repo-${marker}`);
							mkdirSync(join(repo, "extensions"), { recursive: true });
							mkdirSync(join(repo, "lib"));
							git(repo, "init", "--initial-branch=main");
							writeFileSync(
								join(repo, "extensions", "index.ts"),
								'import { marker } from "../lib/marker.ts"; export default function(pi) { pi.events.emit("loaded-api", { api: pi, marker }); }',
							);
							writeFileSync(join(repo, "lib", "marker.ts"), `export const marker = ${JSON.stringify(marker)};`);
							git(repo, "add", "extensions/index.ts", "lib/marker.ts");
							git(repo, "commit", "-m", `repository ${marker}`);
							git(
								root,
								"clone",
								"--bare",
								repo,
								join(transportRoot, index === 0 ? "elsewhere" : "fixture", "voice"),
							);
							return git(repo, "rev-parse", "HEAD");
						});
						expect(heads[0]).not.toBe(heads[1]);
						// Native realpath resolves symlinks before /../; Node's JS realpath first shortens the path.
						expect(realpathSync.native(`${transportRoot}/fixture/link/../voice`)).toBe(
							join(transportRoot, "elsewhere", "voice"),
						);
						expect(realpathSync.native(`${transportRoot}/fixture/voice`)).toBe(
							join(transportRoot, "fixture", "voice"),
						);
						const transportLog = join(root, "ssh.jsonl");
						const ssh = join(root, "ssh.cjs");
						writeFileSync(
							ssh,
							`#!${process.execPath}
const { appendFileSync, realpathSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const command = process.argv.at(-1);
const match = /^git-upload-pack '([^']+)'$/.exec(command || "");
if (!match || !match[1].startsWith("/")) process.exit(2);
appendFileSync(${JSON.stringify(transportLog)}, JSON.stringify(match[1]) + "\\n");
// Resolve the raw transport path with POSIX semantics before invoking the repository service.
const repository = realpathSync.native(${JSON.stringify(transportRoot)} + match[1]);
const result = spawnSync("git", ["upload-pack", repository], { stdio: "inherit", timeout: 10000 });
process.exit(result.status ?? 1);
`,
							{ mode: 0o755 },
						);
						vi.stubEnv("GIT_SSH_COMMAND", `'${ssh}'`);
						vi.stubEnv("GIT_SSH_VARIANT", "ssh");
						vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
						vi.stubEnv("GIT_CONFIG_GLOBAL", join(root, "no-global-config"));
						vi.stubEnv("GIT_CONFIG_COUNT", "0");
						vi.stubEnv("PI_OFFLINE", "0");
						const urlA = `ssh://git@fixture.invalid${path}`;
						const urlB = "ssh://git@fixture.invalid/fixture/voice";
						const sourceA = `git:${urlA}`;
						const sourceB = `git:${urlB}`;
						expect(parseGitUrl(sourceA)?.repo).toBe(urlA);
						expect(parseGitUrl(sourceA)?.path).toBe(parseGitUrl(sourceB)?.path);
						expect(new URL(urlA).href).toBe(urlB);
						let cachedRoot: string | undefined;
						let matchedBRoot: string | undefined;
						for (const phase of [
							"unapproved-a",
							"requested-b",
							"ambiguous-matching-a",
							"file-grant",
							"matched-a",
							"matched-b",
							"ambiguous-request-b",
							"ambiguous-request-file",
						] as const) {
							const ambiguousRequest = phase === "ambiguous-request-b" || phase === "ambiguous-request-file";
							const matched = phase === "matched-a" || phase === "matched-b";
							const isB = phase === "matched-b" || ambiguousRequest;
							const profile = ambiguousRequest
								? join(root, "matched-b")
								: matched
									? join(root, phase)
									: agentDir;
							mkdirSync(profile, { recursive: true });
							const requested = ambiguousRequest
								? "git:ssh://git@fixture.invalid/fixture/./voice"
								: phase === "matched-a"
									? "git:ssh://git@fixture.invalid/elsewhere/voice"
									: phase === "unapproved-a" || phase === "ambiguous-matching-a"
										? sourceA
										: sourceB;
							const allowed =
								phase === "ambiguous-request-file"
									? join(matchedBRoot!, "extensions", "index.ts")
									: phase === "file-grant"
										? join(cachedRoot!, "extensions", "index.ts")
										: matched || ambiguousRequest || phase === "ambiguous-matching-a"
											? requested
											: sourceB;
							writeFileSync(
								join(profile, "settings.json"),
								JSON.stringify({
									...(ingress === "global-packages" ? { packages: [requested] } : {}),
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
								additionalExtensionPaths: ingress === "additionalExtensionPaths" ? [requested] : [],
							});
							await loader.reload();
							expect(loader.getExtensions().errors, phase).toEqual([]);
							expect(loader.getExtensions().extensions, phase).toHaveLength(1);
							const extension = loader.getExtensions().extensions[0];
							const installedRoot = extension.sourceInfo.baseDir!;
							if (phase === "unapproved-a") cachedRoot = installedRoot;
							if (phase === "matched-b") matchedBRoot = installedRoot;
							if (ambiguousRequest) expect(installedRoot, phase).toBe(matchedBRoot);
							else if (!matched) expect(installedRoot, phase).toBe(cachedRoot);
							expect(extension.sourceInfo.source, phase).toBe(requested);
							expect(marker, phase).toBe(isB ? "B" : "A");
							expect(git(installedRoot, "rev-parse", "HEAD^{commit}"), phase).toBe(heads[isB ? 1 : 0]);
							expect(git(installedRoot, "rev-parse", "origin/HEAD^{commit}"), phase).toBe(heads[isB ? 1 : 0]);
							expect(git(installedRoot, "config", "--local", "--get", "remote.origin.url"), phase).toBe(
								ambiguousRequest ? urlB : matched ? requested.slice(4) : urlA,
							);
							if (phase === "requested-b") {
								const transported = readFileSync(transportLog, "utf8")
									.trim()
									.split("\n")
									.map((line) => JSON.parse(line) as string);
								// This Git client decodes %2e before SSH; the fixture performs no URI decoding.
								// Temporary sources actually refresh the existing A origin; global packages reuse it unchanged.
								expect(transported).toEqual(
									Array(ingress === "additionalExtensionPaths" ? 2 : 1).fill("/fixture/link/../voice"),
								);
							}
							const harness = await createHarness({
								persistSession: true,
								resourceLoader: loader,
								settings: settings.getGlobalSettings(),
							});
							harnesses.push(harness);
							await harness.session.bindExtensions({});
							await receipt(
								harness,
								api,
								claim,
								// PR #95 R8: safe endpoint equality does not supply complete implementation attestation.
								phase === "file-grant" || phase === "ambiguous-request-file",
								`${phase}: helper ${marker}`,
							);
						}
					},
					30_000,
				);
			}
		}
	}
});
