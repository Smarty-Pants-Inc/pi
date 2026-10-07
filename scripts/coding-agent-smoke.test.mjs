import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { installConsumer } from "./local-package-install.mjs";
import { produceArtifactSet } from "./package-artifacts.mjs";
import { codingAgentName, smokeTestCodingAgent } from "./coding-agent-smoke.mjs";

const devPackages = ["pi-client", "pi-protocol", "pi-server"].map((name) => `@earendil-works/${name}`);

function writePackage(directory, manifest, files) {
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(directory, path)), { recursive: true });
		writeFileSync(join(directory, path), content);
	}
}

function createFixture(t, { importServer = false, declareServer = false } = {}) {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-coding-agent-smoke-test-"));
	t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
	const root = join(temporaryRoot, "fixture with spaces");
	const repoRoot = join(root, "repo");
	mkdirSync(repoRoot, { recursive: true });
	writeFileSync(join(repoRoot, "package.json"), '{"name":"fixture","private":true}\n');
	const packageNames = [codingAgentName, ...devPackages];
	for (const name of packageNames) {
		const isAgent = name === codingAgentName;
		writePackage(
			join(repoRoot, "packages", name.split("/")[1]),
			{
				name,
				version: "1.0.0",
				type: "module",
				main: "./dist/index.js",
				types: "./dist/index.d.ts",
				exports: isAgent
					? {
						".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
						"./ordinary": { types: "./dist/ordinary.d.ts", import: "./dist/ordinary.js" },
						"./client": { source: "./src/client/index.ts" },
						"./experimental/plugin": { source: "./src/experimental/plugin.ts" },
					}
					: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
				files: ["dist"],
				...(isAgent
					? {
						bin: { pi: "dist/bundle/cli.js" },
						...(declareServer ? { dependencies: { "@earendil-works/pi-server": "1.0.0" } } : {}),
						devDependencies: Object.fromEntries(devPackages.map((packageName) => [packageName, "1.0.0"])),
					}
					: {}),
			},
			{
				"dist/index.js": isAgent
					? `${importServer ? 'import "@earendil-works/pi-server";' : ""}
export function createAgentSession() {}
export class SessionManager { static inMemory() {} }
export class ModelRuntime { static create() {} }
`
					: "export {};\n",
				"dist/index.d.ts": "export {};\n",
				...(isAgent
					? {
						"dist/cli.js": 'console.log("1.0.0");\n',
						"dist/bundle/cli.js": 'console.log("1.0.0");\n',
						// Synthetic contract fixtures only, not the real loader, owner or installed Pi proof.
						"dist/ordinary.js": `
import { fileURLToPath } from "node:url";
export { captureOrdinaryRequestPair, consumeOrdinaryPairedInput } from "./core/ordinary-request-pair.js";
export const ordinaryApplicationPath = fileURLToPath(import.meta.url);
export function assertOrdinaryOwner() { throw new Error("OWNER_PROFILE_UNAVAILABLE: no received ordinary owner"); }
`,
						"dist/ordinary.d.ts": "export {};",
						"dist/core/ordinary-request-pair.js": `
export function captureOrdinaryRequestPair() { throw new Error("Synthetic capture must not be invoked"); }
export function consumeOrdinaryPairedInput() { throw new Error("Synthetic consumer must not be invoked"); }
`,
						"dist/core/ordinary-owner-context.js": "export class OrdinaryOwnerContext {}",
						"dist/core/extensions/loader.js": `
import { captureOrdinaryRequestPair, consumeOrdinaryPairedInput } from "../../ordinary.js";
export async function loadExtensions() {
  return {
    errors: [],
    extensions: [{ messageRenderers: new Map([
      ["ordinary-capture-identity", captureOrdinaryRequestPair],
      ["ordinary-consume-identity", consumeOrdinaryPairedInput],
    ]) }],
    runtime: { invalidate() {} },
  };
}
`,
					}
					: {}),
			},
		);
	}
	const artifactSet = produceArtifactSet({ build: false, outDir: join(root, "artifacts"), repoRoot, source: null });
	const directory = join(root, "consumer");
	installConsumer({ artifactSet, directory, packageNames: [codingAgentName] });
	return directory;
}

test("accepts a valid coding-agent package and rejects development-only packages and files", (t) => {
	const directory = createFixture(t);
	smokeTestCodingAgent(directory);
	const proofPath = join(directory, "ordinary-consumer-proof.json");
	const proof = JSON.parse(readFileSync(proofPath, "utf8"));
	assert.equal(proof.schema, "pi-installed-ordinary-consumer/1");
	assert.equal(proof.status, "PASS");
	assert.equal(proof.scope, "installed-public-export-and-original-function-identity");
	assert.deepEqual(proof.checks, {
		publicEntry: true, originalCapture: true, originalConsume: true, extensionLoaderIdentity: true, forgedOwnerRefused: true,
	});
	assert.equal(proof.nativeReceiving, false);
	assert.equal(proof.providerOrGrantOperations, false);
	assert.equal(Object.keys(proof.files).length, 6);
	for (const hash of Object.values(proof.files)) assert.match(hash, /^[a-f0-9]{64}$/);

	const nested = join(directory, "node_modules", codingAgentName, "node_modules/@earendil-works/pi-server");
	mkdirSync(nested, { recursive: true });
	writeFileSync(join(nested, "package.json"), JSON.stringify({ name: "@earendil-works/pi-server", version: "1.0.0" }));
	assert.throws(() => smokeTestCodingAgent(directory), /pi-server must not be installed/);
	assert.equal(existsSync(proofPath), false);
	rmSync(nested, { recursive: true });

	const experimental = join(directory, "node_modules", codingAgentName, "dist/experimental");
	mkdirSync(experimental);
	assert.throws(() => smokeTestCodingAgent(directory), /contains development-only code/);
});

// These failures exercise the probe with synthetic packages, not actual Pi artifact qualification.
test("requires the ordinary export and rejects changed public or loader function identities", (t) => {
	const directory = createFixture(t);
	const packageDir = join(directory, "node_modules", codingAgentName);
	const proofPath = join(directory, "ordinary-consumer-proof.json");
	const cases = [
		["package.json", (text) => {
			const manifest = JSON.parse(text);
			delete manifest.exports["./ordinary"];
			return JSON.stringify(manifest);
		}],
		["dist/ordinary.js", (text) => text.replace(
			"captureOrdinaryRequestPair, consumeOrdinaryPairedInput",
			"captureOrdinaryRequestPair, captureOrdinaryRequestPair as consumeOrdinaryPairedInput",
		)],
		["dist/core/extensions/loader.js", (text) => text.replace(
			'["ordinary-consume-identity", consumeOrdinaryPairedInput]',
			'["ordinary-consume-identity", () => {}]',
		)],
	];
	for (const [path, change] of cases) {
		const file = join(packageDir, path);
		const original = readFileSync(file, "utf8");
		const changed = change(original);
		assert.notEqual(changed, original);
		writeFileSync(file, changed);
		writeFileSync(proofPath, "stale proof");
		try {
			assert.throws(() => smokeTestCodingAgent(directory), /ERR_PACKAGE_PATH_NOT_EXPORTED|AssertionError/, path);
			assert.equal(existsSync(proofPath), false);
		} finally {
			writeFileSync(file, original);
		}
	}
});

// #9132: smoke-test the public SDK, not just a bundled CLI that hides missing imports.
test("fails when the SDK imports an undeclared server despite a working CLI", (t) => {
	const directory = createFixture(t, { importServer: true });
	assert.throws(() => smokeTestCodingAgent(directory), /Cannot find package '@earendil-works\/pi-server'/);
});

test("fails if a development-only dependency is added back to the published dependency tree", (t) => {
	const directory = createFixture(t, { declareServer: true });
	assert.throws(() => smokeTestCodingAgent(directory), /pi-server must not be installed/);
});
