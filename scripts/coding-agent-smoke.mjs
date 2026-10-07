import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const codingAgentName = "@earendil-works/pi-coding-agent";
const developmentPackages = new Set(["pi-client", "pi-protocol", "pi-server"].map((name) => `@earendil-works/${name}`));

function checkInstalledPackages(nodeModules, seen = new Set()) {
	if (!existsSync(nodeModules)) return;
	const directories = readdirSync(nodeModules)
		.filter((name) => !name.startsWith("."))
		.flatMap((name) => name.startsWith("@")
			? readdirSync(join(nodeModules, name)).map((child) => join(nodeModules, name, child))
			: [join(nodeModules, name)]);
	for (const directory of directories) {
		if (!existsSync(join(directory, "package.json"))) continue;
		const path = realpathSync(directory);
		if (seen.has(path)) continue;
		seen.add(path);
		const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
		if (developmentPackages.has(manifest.name)) throw new Error(`${manifest.name} must not be installed: ${path}`);
		checkInstalledPackages(join(path, "node_modules"), seen);
	}
}

export function smokeTestCodingAgent(directory, runtime = process.execPath) {
	const proofPath = join(directory, "ordinary-consumer-proof.json");
	rmSync(proofPath, { force: true });
	checkInstalledPackages(join(directory, "node_modules"));
	const packageDir = join(directory, "node_modules", codingAgentName);
	const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	for (const path of ["dist/client", "dist/experimental", "dist/cli/experimental", "dist/bundle/client.js", "dist/bundle/coordinator.js"]) {
		if (existsSync(join(packageDir, path))) throw new Error(`Published package contains development-only code: ${path}`);
	}
	const home = mkdtempSync(join(tmpdir(), "pi-coding-agent-smoke-home-"));
	const entry = join(directory, "coding-agent-smoke.mjs");
	const env = {
		PATH: process.env.PATH,
		HOME: home,
		USERPROFILE: home,
		APPDATA: home,
		LOCALAPPDATA: home,
		XDG_CONFIG_HOME: home,
		XDG_CACHE_HOME: home,
		PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
	};
	for (const name of ["SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
		if (process.env[name]) env[name] = process.env[name];
	}
	try {
		writeFileSync(entry, `import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createAgentSession, SessionManager, ModelRuntime } from "${codingAgentName}";
import { assertOrdinaryOwner, captureOrdinaryRequestPair, consumeOrdinaryPairedInput, ordinaryApplicationPath } from "${codingAgentName}/ordinary";
import { captureOrdinaryRequestPair as originalCapture, consumeOrdinaryPairedInput as originalConsume } from "./node_modules/${codingAgentName}/dist/core/ordinary-request-pair.js";
import { OrdinaryOwnerContext } from "./node_modules/${codingAgentName}/dist/core/ordinary-owner-context.js";
import { loadExtensions } from "./node_modules/${codingAgentName}/dist/core/extensions/loader.js";
assert.equal(typeof createAgentSession, "function");
assert.equal(typeof SessionManager.inMemory, "function");
assert.equal(typeof ModelRuntime.create, "function");
for (const subpath of ["/client", "/experimental/plugin"]) {
  assert.throws(() => import.meta.resolve("${codingAgentName}" + subpath), /not exported|not defined|Cannot find|cannot find/);
}
const packageUrl = new URL("./node_modules/${codingAgentName}/", import.meta.url);
const ordinaryUrl = new URL("dist/ordinary.js", packageUrl);
assert.equal(import.meta.resolve("${codingAgentName}/ordinary"), ordinaryUrl.href);
assert.equal(ordinaryApplicationPath, fileURLToPath(ordinaryUrl));
assert.equal(captureOrdinaryRequestPair, originalCapture);
assert.equal(consumeOrdinaryPairedInput, originalConsume);
assert.throws(() => assertOrdinaryOwner(Object.create(OrdinaryOwnerContext.prototype)), {
  message: "OWNER_PROFILE_UNAVAILABLE: no received ordinary owner",
});
const extension = ${JSON.stringify(join(home, "ordinary-identity.ts"))};
writeFileSync(extension, ${JSON.stringify(`import { captureOrdinaryRequestPair, consumeOrdinaryPairedInput } from "${codingAgentName}/ordinary";
export default function(pi) {
  pi.registerMessageRenderer("ordinary-capture-identity", captureOrdinaryRequestPair);
  pi.registerMessageRenderer("ordinary-consume-identity", consumeOrdinaryPairedInput);
}
`)});
const loaded = await loadExtensions([extension], ${JSON.stringify(home)});
try {
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.equal(loaded.extensions[0].messageRenderers.get("ordinary-capture-identity"), originalCapture);
  assert.equal(loaded.extensions[0].messageRenderers.get("ordinary-consume-identity"), originalConsume);
} finally {
  loaded.runtime.invalidate();
}
writeFileSync(${JSON.stringify(join(home, "ordinary-consumer-proof.json"))}, JSON.stringify({
  schema: "pi-installed-ordinary-consumer/1",
  status: "PASS",
  scope: "installed-public-export-and-original-function-identity",
  runtime: { executable: process.execPath, versions: process.versions },
  ordinaryApplicationPath,
  checks: { publicEntry: true, originalCapture: true, originalConsume: true, extensionLoaderIdentity: true, forgedOwnerRefused: true },
  nativeReceiving: false,
  providerOrGrantOperations: false,
  files: Object.fromEntries([
    "package.json", "dist/ordinary.js", "dist/ordinary.d.ts", "dist/core/ordinary-request-pair.js",
    "dist/core/ordinary-owner-context.js", "dist/core/extensions/loader.js",
  ].map(path => [path, createHash("sha256").update(readFileSync(new URL(path, packageUrl))).digest("hex")])),
}, null, 2) + "\\n");
`);
		execFileSync(runtime, [entry], { cwd: directory, env, stdio: ["inherit", "pipe", "pipe"], timeout: 30_000 });
		for (const cli of new Set([manifest.bin.pi, "dist/cli.js"])) {
			const output = execFileSync(runtime, [join(packageDir, cli), "--version"], {
				cwd: directory,
				encoding: "utf8",
				env,
				stdio: ["inherit", "pipe", "pipe"],
				timeout: 30_000,
			});
			if (output.trim() !== manifest.version) throw new Error(`Unexpected version from ${cli}: ${output}`);
		}
		writeFileSync(proofPath, readFileSync(join(home, "ordinary-consumer-proof.json")));
	} finally {
		rmSync(entry, { force: true });
		rmSync(home, { recursive: true, force: true });
	}
	console.log(`Coding-agent policy smoke tests passed (${runtime}).`);
}
