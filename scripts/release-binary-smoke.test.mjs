import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// pi#137 A4: the release smoke job starts on a fresh runner without the build job's checkout.
// The executable JS fixture uses a POSIX shebang; Windows still uses the same artifact extraction in CI.
test("release smoke obtains its script from the same source artifact as the binary", { skip: process.platform === "win32" }, () => {
	const workflow = readFileSync(new URL("../.github/workflows/build-binaries.yml", import.meta.url), "utf8");
	const job = workflow.split("  smoke-test-binaries:")[1].split("  stage-github-release:")[0];
	const run = job.match(/      - name: Smoke-test binary\n        shell: bash\n        run: \|\n((?:          [^\n]*\n)+)/)?.[1];
	assert.ok(run, "Smoke-test binary shell step missing");
	assert.match(job, /permissions:\n      actions: read\n/);
	assert.doesNotMatch(job, /contents: write|persist-credentials: true/);

	const root = mkdtempSync(join(tmpdir(), "pi-fresh-release-smoke-"));
	try {
		const version = "1.0.1";
		const build = join(root, "build");
		const workspace = join(root, "fresh-runner");
		mkdirSync(join(build, `pi-${version}`, "scripts"), { recursive: true });
		mkdirSync(join(workspace, "release-assets"), { recursive: true });
		const script = readFileSync(new URL("./smoke-test-codemode-binary.mjs", import.meta.url), "utf8");
		writeFileSync(join(build, `pi-${version}`, "scripts", "smoke-test-codemode-binary.mjs"), script);
		execFileSync("tar", ["-czf", join(workspace, "release-assets", `pi-${version}-source.tar.gz`), "-C", build, `pi-${version}`]);
		rmSync(build, { recursive: true });
		assert.equal(existsSync(join(workspace, "scripts")), false);

		// A local protocol fixture isolates script delivery from cross-platform binary compilation.
		const binary = join(workspace, "pi.js");
		writeFileSync(binary, `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--help") || process.argv.includes("--version")) {
	console.log("smoke binary fixture");
} else {
	(async () => {
		const models = JSON.parse(fs.readFileSync(process.env.PI_CODING_AGENT_DIR + "/models.json", "utf8"));
		const url = models.providers["codemode-smoke"].baseUrl + "/chat/completions";
		await (await fetch(url, { method: "POST", body: "{}" })).text();
		const response = await fetch(url, { method: "POST", body: JSON.stringify({ messages: [{ role: "tool", content: "PI_CODEMODE_WORKER_OK" }] }) });
		const text = await response.text();
		if (!text.includes("PI_CODEMODE_BINARY_SMOKE_OK")) throw new Error(text);
		console.log("PI_CODEMODE_BINARY_SMOKE_OK");
	})().catch(error => { console.error(error); process.exitCode = 1; });
}
`);
		chmodSync(binary, 0o700);
		const commands = run.replace(/^          /gm, "").replaceAll("${{ steps.binary.outputs.binary }}", "./pi.js");
		const shellScript = join(root, "smoke-step.sh");
		writeFileSync(shellScript, `set -euo pipefail\n${commands}`);
		const result = spawnSync("bash", [shellScript], {
			cwd: workspace,
			env: { ...process.env, RELEASE_TAG: `v${version}` },
			encoding: "utf8", timeout: 45_000,
		});
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, /PI_CODEMODE_BINARY_SMOKE_OK/);
		assert.equal(readFileSync(join(workspace, "smoke-source", `pi-${version}`, "scripts", "smoke-test-codemode-binary.mjs"), "utf8"), script);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
