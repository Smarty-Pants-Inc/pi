// pi#95 security R5: a Git grant belongs to tracked, evaluated implementation, not its containing directory/current HEAD.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../../../src/core/event-bus.ts";
import { clearExtensionCache } from "../../../src/core/extensions/loader.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { DefaultPackageManager } from "../../../src/core/package-manager.ts";
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
	vi.restoreAllMocks();
	clearExtensionCache();
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
function fixture() {
	clearExtensionCache();
	const root = mkdtempSync(join(tmpdir(), "pi-95-git-implementation-"));
	directories.push(root);
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	vi.stubEnv("PI_OFFLINE", "0");
	return { root, cwd, agentDir };
}
function repository(root: string, name: string, url: string, file: string, content: string, index: number) {
	const repo = join(root, name);
	const bare = join(root, `${name}-bare`);
	mkdirSync(join(repo, "extensions"), { recursive: true });
	git(repo, "init", "--initial-branch=approved");
	writeFileSync(join(repo, file), content);
	git(repo, "add", file);
	git(repo, "commit", "-m", name);
	git(root, "clone", "--bare", repo, bare);
	vi.stubEnv(`GIT_CONFIG_KEY_${index}`, `url.${pathToFileURL(bare).href}.insteadOf`);
	vi.stubEnv(`GIT_CONFIG_VALUE_${index}`, url);
	return { repo, bare };
}
const factory = (marker: string) =>
	`export default function(pi) { pi.events.emit("loaded-api", { api: pi, marker: ${JSON.stringify(marker)} }); }`;
async function load(cwd: string, agentDir: string) {
	const settings = SettingsManager.create(cwd, agentDir);
	const apis = new Map<string, ExtensionAPI>();
	const eventBus = createEventBus();
	eventBus.on("loaded-api", (value) => {
		const { api, marker } = value as { api: ExtensionAPI; marker: string };
		apis.set(marker, api);
	});
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: settings,
		eventBus,
		noContextFiles: true,
	});
	await loader.reload();
	expect(loader.getExtensions().errors).toEqual([]);
	const harness = await createHarness({
		persistSession: true,
		resourceLoader: loader,
		settings: settings.getGlobalSettings(),
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	return { harness, loader, apis, eventBus };
}
async function receipt(
	harness: Harness,
	api: ExtensionAPI,
	claim: TurnProvenanceClaim,
	admitted: boolean,
	label: string,
) {
	const before = harness.sessionManager.getEntries().filter((entry) => getTurnProvenance(entry)).length;
	harness.setResponses([fauxAssistantMessage("done")]);
	api.sendMessage({ customType: "implementation-claim", content: label, display: false }, { provenance: claim });
	api.sendUserMessage(label, { provenance: claim });
	await vi.waitFor(() =>
		expect(harness.sessionManager.getEntries().filter((entry) => getTurnProvenance(entry))).toHaveLength(before + 2),
	);
	await harness.session.agent.waitForIdle();
	const entries = harness.sessionManager.getEntries().filter((entry) => getTurnProvenance(entry));
	const records = entries.slice(before).map(getTurnProvenance);
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
		} else if (claim.channel === "voice") expect(record?.principal).toEqual({ id: "paul", binding: "voice-call" });
		else {
			expect(record?.sender).toEqual(claim.sender);
			expect(record?.via).toBe("steer");
		}
	}
	expect(records[0]?.turnId).not.toBe(records[1]?.turnId);
	const file = harness.sessionManager.getSessionFile()!;
	const lines = readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as SessionEntry);
	expect(lines.filter((entry) => getTurnProvenance(entry))).toEqual(entries);
	const reopened = SessionManager.open(file, harness.tempDir);
	expect(reopened.getEntries().filter((entry) => getTurnProvenance(entry))).toEqual(entries);
	expect(
		reopened.buildSessionContext().messages.filter((message) => message.role === "user" || message.role === "custom"),
	).toHaveLength(before + 2);
}
function configure(agentDir: string, allowed: string) {
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ turnProvenance: { voiceExtensions: [allowed], fabricExtensions: [allowed] } }),
	);
}

describe("pi#95 Git implementation authority", () => {
	for (const claim of claims) {
		it(`public install/default discovery: nested ${claim.channel} cannot inherit outer grant`, async () => {
			const { root, cwd, agentDir } = fixture();
			const outerUrl = "git://127.0.0.1:19418/fixture/outer";
			const childUrl = `${outerUrl}/extensions/child`;
			repository(root, "outer", outerUrl, "extensions/tracked.ts", factory("outer"), 0);
			repository(root, "child", childUrl, "extensions/unused.ts", factory("unused"), 1);
			// Child entry is in its own repository root, discovered as extensions/<child>/index.ts by the outer.
			const childRepo = join(root, "child");
			writeFileSync(join(childRepo, "index.ts"), factory("child"));
			git(childRepo, "add", "index.ts");
			git(childRepo, "commit", "-m", "child entry");
			git(childRepo, "push", join(root, "child-bare"), "approved");
			vi.stubEnv("GIT_CONFIG_COUNT", "2");
			const outer = `git:${outerUrl}@approved`;
			const child = `git:${childUrl}@approved`;
			configure(agentDir, outer);
			const settings = SettingsManager.create(cwd, agentDir);
			const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
			await manager.installAndPersist(outer);
			await manager.install(child);
			const installed = manager.getInstalledPath(outer, "user")!;
			expect(manager.getInstalledPath(child, "user")).toBe(join(installed, "extensions", "child"));
			expect(settings.getGlobalSettings().packages).toEqual([outer]);
			expect(git(installed, "ls-tree", "HEAD", "extensions/child/index.ts")).toBe("");
			const { harness, loader, apis } = await load(cwd, agentDir);
			expect([...apis.keys()].sort()).toEqual(["child", "outer"]);
			expect(
				loader.getExtensions().extensions.find((extension) => extension.path.endsWith("child/index.ts"))?.sourceInfo
					.source,
			).toBe(outer);
			await receipt(harness, apis.get("outer")!, claim, false, "tracked outer source grant deliberately refused");
			await receipt(harness, apis.get("child")!, claim, false, "nested child");
		}, 30_000);

		it(`untracked/modified entries: ${claim.channel} fail closed; explicit file trust still works`, async () => {
			const { root, cwd, agentDir } = fixture();
			const url = "git://127.0.0.1:19418/fixture/voice";
			repository(root, "repo", url, "extensions/tracked.ts", factory("tracked"), 0);
			vi.stubEnv("GIT_CONFIG_COUNT", "1");
			const source = `git:${url}@approved`;
			configure(agentDir, source);
			const settings = SettingsManager.create(cwd, agentDir);
			const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
			await manager.installAndPersist(source);
			const installed = manager.getInstalledPath(source, "user")!;
			const untracked = join(installed, "extensions", "untracked.ts");
			writeFileSync(untracked, factory("untracked"));
			writeFileSync(join(installed, "extensions", "tracked.ts"), factory("modified"));
			const loaded = await load(cwd, agentDir);
			await receipt(loaded.harness, loaded.apis.get("modified")!, claim, false, "modified committed entry");
			await receipt(loaded.harness, loaded.apis.get("untracked")!, claim, false, "untracked entry");
			configure(agentDir, untracked);
			const fileSettings = SettingsManager.create(cwd, agentDir);
			fileSettings.setPackages([source]);
			const explicit = await load(cwd, agentDir);
			await receipt(explicit.harness, explicit.apis.get("untracked")!, claim, true, "explicit file grant");
		}, 30_000);

		it(`deferred untracked dependency: ${claim.channel} revokes source authority at receipt`, async () => {
			const { root, cwd, agentDir } = fixture();
			const url = "git://127.0.0.1:19418/fixture/voice";
			repository(
				root,
				"repo",
				url,
				"extensions/index.ts",
				`export default function(pi) {
				pi.events.on("load-helper", async () => {
					const helper = await import("../lib/untracked.ts");
					pi.events.emit("helper-loaded", helper.marker);
				});
				pi.events.emit("loaded-api", { api: pi, marker: "entry" });
			}`,
				0,
			);
			vi.stubEnv("GIT_CONFIG_COUNT", "1");
			const source = `git:${url}@approved`;
			configure(agentDir, source);
			const settings = SettingsManager.create(cwd, agentDir);
			const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
			await manager.installAndPersist(source);
			const installed = manager.getInstalledPath(source, "user")!;
			mkdirSync(join(installed, "lib"));
			writeFileSync(join(installed, "lib", "untracked.ts"), "export const marker = 'untracked helper';");
			const loaded = await load(cwd, agentDir);
			await receipt(
				loaded.harness,
				loaded.apis.get("entry")!,
				claim,
				false,
				"tracked entry before deferred evaluation: source grant deliberately refused",
			);
			let marker: unknown;
			loaded.eventBus.on("helper-loaded", (value) => {
				marker = value;
			});
			loaded.eventBus.emit("load-helper", undefined);
			await vi.waitFor(() => expect(marker).toBe("untracked helper"));
			await receipt(
				loaded.harness,
				loaded.apis.get("entry")!,
				claim,
				false,
				"untracked dependency after deferred evaluation",
			);
		}, 30_000);

		it(`native dependency: ${claim.channel} fails closed without changing ordinary loading or file trust`, async () => {
			const { root, cwd, agentDir } = fixture();
			const url = "git://127.0.0.1:19418/fixture/voice";
			const { repo, bare } = repository(
				root,
				"repo",
				url,
				"extensions/index.ts",
				"import factory from '../lib/factory.cjs'; export default factory;",
				0,
			);
			mkdirSync(join(repo, "lib"));
			writeFileSync(
				join(repo, "lib/factory.cjs"),
				"module.exports = function(pi) { pi.events.emit('loaded-api', { api: pi, marker: 'native' }); };",
			);
			git(repo, "add", "lib/factory.cjs");
			git(repo, "commit", "-m", "native dependency");
			git(repo, "push", bare, "approved");
			vi.stubEnv("GIT_CONFIG_COUNT", "1");
			const source = `git:${url}@approved`;
			configure(agentDir, source);
			const settings = SettingsManager.create(cwd, agentDir);
			const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
			await manager.installAndPersist(source);
			const loaded = await load(cwd, agentDir);
			expect([...loaded.apis.keys()]).toEqual(["native"]);
			await receipt(
				loaded.harness,
				loaded.apis.get("native")!,
				claim,
				false,
				"native evaluation cannot prove source bytes",
			);
			const entry = join(manager.getInstalledPath(source, "user")!, "extensions", "index.ts");
			configure(agentDir, entry);
			SettingsManager.create(cwd, agentDir).setPackages([source]);
			const explicit = await load(cwd, agentDir);
			await receipt(explicit.harness, explicit.apis.get("native")!, claim, true, "explicit native file grant");
		}, 30_000);

		// PR #95 R8: global builtin acquisition bypasses the Jiti observer and retains native helper A.
		it(`global native acquisition: ${claim.channel} refuses A cached under a fresh B API`, async () => {
			const { root, cwd, agentDir } = fixture();
			const url = "git://127.0.0.1:19418/fixture/global-native";
			const { repo, bare } = repository(
				root,
				"repo",
				url,
				"extensions/index.ts",
				`const nativeRequire = process.getBuiltinModule("module").createRequire(import.meta.url);
				export default nativeRequire("../lib/factory.cjs");`,
				0,
			);
			mkdirSync(join(repo, "lib"));
			writeFileSync(
				join(repo, "lib/factory.cjs"),
				`module.exports = ${factory("native-A").replace("export default ", "")};`,
			);
			git(repo, "add", "lib/factory.cjs");
			git(repo, "commit", "-m", "native implementation A");
			git(repo, "branch", "revision-a");
			writeFileSync(
				join(repo, "lib/factory.cjs"),
				`module.exports = ${factory("native-B").replace("export default ", "")};`,
			);
			git(repo, "add", "lib/factory.cjs");
			git(repo, "commit", "-m", "native implementation B");
			const b = git(repo, "rev-parse", "HEAD");
			git(repo, "push", bare, "approved", "revision-a");
			vi.stubEnv("GIT_CONFIG_COUNT", "1");
			const sourceA = `git:${url}@revision-a`;
			const sourceB = `git:${url}@${b}`;
			configure(agentDir, sourceB);
			const settings = SettingsManager.create(cwd, agentDir);
			const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
			await manager.installAndPersist(sourceA);
			const installed = manager.getInstalledPath(sourceA, "user")!;
			const first = await load(cwd, agentDir);
			expect([...first.apis.keys()]).toEqual(["native-A"]);
			await receipt(first.harness, first.apis.get("native-A")!, claim, false, "untrusted native A");
			await manager.installAndPersist(sourceB);
			expect(git(installed, "rev-parse", "HEAD")).toBe(b);
			expect(readFileSync(join(installed, "lib/factory.cjs"), "utf8")).toContain("native-B");
			const stderr = vi.spyOn(process.stderr, "write");
			const second = await load(cwd, agentDir);
			expect([...second.apis.keys()]).toEqual(["native-A"]);
			await receipt(second.harness, second.apis.get("native-A")!, claim, false, "cached native A with fresh B API");
			const entry = join(installed, "extensions/index.ts");
			const diagnostics = stderr.mock.calls
				.map(([text]) => String(text))
				.filter((text) => text.startsWith("Turn provenance:"));
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0]).toContain(JSON.stringify(sourceB));
			expect(diagnostics[0]).toContain("trust its installed file/directory path");
			expect(diagnostics[0]).toContain(JSON.stringify(entry));
			expect(diagnostics[0].trimEnd().split("\n")).toHaveLength(1);
			configure(agentDir, entry);
			SettingsManager.create(cwd, agentDir).setPackages([sourceB]);
			const explicit = await load(cwd, agentDir);
			expect([...explicit.apis.keys()]).toEqual(["native-A"]);
			await receipt(explicit.harness, explicit.apis.get("native-A")!, claim, true, "explicit evaluated entry trust");
		}, 30_000);

		// PR #95 R8: the fleet's explicit release-directory installs remain authorized, including native loading.
		it(`explicit release-directory install: ${claim.channel} remains authorized without source-string grants`, async () => {
			const { root, cwd, agentDir } = fixture();
			const releases = join(root, "releases", "fabric");
			const release = join(releases, "2026-10-01");
			mkdirSync(join(release, "extensions"), { recursive: true });
			mkdirSync(join(release, "lib"));
			writeFileSync(join(release, "package.json"), JSON.stringify({ pi: { extensions: ["extensions/index.ts"] } }));
			writeFileSync(
				join(release, "extensions/index.ts"),
				`const nativeRequire = process.getBuiltinModule("module").createRequire(import.meta.url); export default nativeRequire("../lib/factory.cjs");`,
			);
			writeFileSync(
				join(release, "lib/factory.cjs"),
				`module.exports = ${factory("native-release").replace("export default ", "")};`,
			);
			configure(agentDir, `${releases}/`);
			const settings = SettingsManager.create(cwd, agentDir);
			const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
			await manager.installAndPersist(release);
			expect(settings.getGlobalSettings().packages).toEqual([relative(agentDir, release)]);
			const loaded = await load(cwd, agentDir);
			expect([...loaded.apis.keys()]).toEqual(["native-release"]);
			await receipt(
				loaded.harness,
				loaded.apis.get("native-release")!,
				claim,
				true,
				"explicit release-directory grant",
			);
		});

		it(`evaluator introspection: ${claim.channel} cannot manufacture native dependency evidence`, async () => {
			const { root, cwd, agentDir } = fixture();
			const url = "git://127.0.0.1:19418/fixture/voice";
			const { repo, bare } = repository(
				root,
				"repo",
				url,
				"extensions/index.ts",
				`
				import factory from "../lib/factory.cjs";
				import { readFileSync } from "node:fs";
				import { fileURLToPath } from "node:url";
				const helper = new URL("../lib/factory.cjs", import.meta.url);
				// Transforming current bytes is not evidence that a native cached module evaluated them.
				require.options.transform({ filename: fileURLToPath(helper), source: readFileSync(helper, "utf8") });
				export default factory;
			`,
				0,
			);
			mkdirSync(join(repo, "lib"));
			writeFileSync(
				join(repo, "lib/factory.cjs"),
				"module.exports = function(pi) { pi.events.emit('loaded-api', { api: pi, marker: 'native' }); };",
			);
			git(repo, "add", "lib/factory.cjs");
			git(repo, "commit", "-m", "native implementation");
			git(repo, "push", bare, "approved");
			vi.stubEnv("GIT_CONFIG_COUNT", "1");
			const source = `git:${url}@approved`;
			configure(agentDir, source);
			const settings = SettingsManager.create(cwd, agentDir);
			const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
			await manager.installAndPersist(source);
			const loaded = await load(cwd, agentDir);
			await receipt(
				loaded.harness,
				loaded.apis.get("native")!,
				claim,
				false,
				"public evaluator knobs are not evidence",
			);
		}, 30_000);

		it(`public installAndPersist/new default loader: unchanged entry/new tracked helper ${claim.channel}`, async () => {
			const { root, cwd, agentDir } = fixture();
			const url = "git://127.0.0.1:19418/fixture/voice";
			const { repo, bare } = repository(
				root,
				"repo",
				url,
				"extensions/index.ts",
				"import factory from '../lib/factory.ts'; export default factory;",
				0,
			);
			mkdirSync(join(repo, "lib"));
			writeFileSync(join(repo, "lib/factory.ts"), factory("A"));
			git(repo, "add", "lib/factory.ts");
			git(repo, "commit", "-m", "implementation A");
			const a = git(repo, "rev-parse", "HEAD");
			git(repo, "branch", "revision-a");
			writeFileSync(join(repo, "lib/factory.ts"), factory("B"));
			git(repo, "add", "lib/factory.ts");
			git(repo, "commit", "-m", "implementation B");
			const b = git(repo, "rev-parse", "HEAD");
			git(repo, "push", bare, "approved", "revision-a");
			vi.stubEnv("GIT_CONFIG_COUNT", "1");
			const sourceA = `git:${url}@revision-a`;
			const sourceB = `git:${url}@${b}`;
			configure(agentDir, sourceB);
			const settings = SettingsManager.create(cwd, agentDir);
			const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
			await manager.installAndPersist(sourceA);
			const installed = manager.getInstalledPath(sourceA, "user")!;
			const entry = join(installed, "extensions", "index.ts");
			const before = statSync(entry, { bigint: true });
			const first = await load(cwd, agentDir);
			expect([...first.apis.keys()]).toEqual(["A"]);
			await receipt(first.harness, first.apis.get("A")!, claim, false, "nonapproved A");
			await manager.installAndPersist(sourceB);
			const after = statSync(entry, { bigint: true });
			expect([after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs]).toEqual([
				before.dev,
				before.ino,
				before.size,
				before.mtimeNs,
				before.ctimeNs,
			]);
			expect(git(installed, "rev-parse", "HEAD")).toBe(b);
			expect(a).not.toBe(b);
			expect(settings.getGlobalSettings().packages).toEqual([sourceB]);
			const second = await load(cwd, agentDir);
			expect.soft([...second.apis.keys()], "new loader must execute B, not cached A").toEqual(["B"]);
			await receipt(
				second.harness,
				[...second.apis.values()][0],
				claim,
				false,
				"new loader B source grant deliberately refused",
			);
			// PR #95 R8: explicit evaluated-file trust, not a matching Git selector, authorizes B.
			// Matching B uses the same cached implementation; changing its imported bytes revokes authority.
			configure(agentDir, entry);
			SettingsManager.create(cwd, agentDir).setPackages([sourceB]);
			const positive = await load(cwd, agentDir);
			expect([...positive.apis.keys()]).toEqual(["B"]);
			await receipt(positive.harness, positive.apis.get("B")!, claim, true, "matching tracked B");
			writeFileSync(join(installed, "lib/factory.ts"), factory("edited after evaluation"));
			await receipt(positive.harness, positive.apis.get("B")!, claim, false, "changed helper after evaluation");
		}, 30_000);
	}
});
