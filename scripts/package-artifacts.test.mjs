import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import test from "node:test";
import { produceArtifactSet, readArtifactSet } from "./package-artifacts.mjs";

function writePackage(directory, manifest, files) {
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	for (const [path, contents] of Object.entries(files)) {
		mkdirSync(dirname(join(directory, path)), { recursive: true });
		writeFileSync(join(directory, path), contents);
	}
}

// pi#173 security review: force must not traverse symlinked roots or parent components.
for (const location of ["artifacts root", "output root", "parent component", "dangling output root"]) {
	test(`refuses a symlinked ${location} before forced cleanup`, (t) => {
		const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-artifact-symlink-test-"));
		t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
		const repoRoot = join(temporaryRoot, "repo");
		const outside = join(temporaryRoot, "outside");
		mkdirSync(repoRoot);
		mkdirSync(join(outside, "set"), { recursive: true });
		const sentinel = join(outside, "set", "keep.txt");
		writeFileSync(sentinel, "outside survives");
		let outDir;
		if (location === "artifacts root") {
			symlinkSync(outside, join(repoRoot, ".artifacts"), "dir");
			outDir = join(repoRoot, ".artifacts", "set");
		} else {
			mkdirSync(join(repoRoot, ".artifacts"));
			const link = join(repoRoot, ".artifacts", "link");
			symlinkSync(location === "dangling output root" ? join(outside, "missing") : outside, link, "dir");
			outDir = location === "parent component" ? join(link, "set") : link;
		}
		assert.throws(() => produceArtifactSet({ repoRoot, outDir, build: false, force: true }), /real director/);
		assert.equal(readFileSync(sentinel, "utf8"), "outside survives");
	});
}

// pi#173: internal symlinks are removed themselves; their external targets must survive.
test("forced cleanup removes nested symlinks without following them", (t) => {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-artifact-symlink-test-"));
	t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
	const repoRoot = join(temporaryRoot, "repo");
	const outDir = join(repoRoot, ".artifacts", "set");
	const outside = join(temporaryRoot, "outside");
	mkdirSync(join(repoRoot, "packages"), { recursive: true });
	mkdirSync(join(outDir, "nested"), { recursive: true });
	mkdirSync(outside);
	const sentinel = join(outside, "keep.txt");
	writeFileSync(sentinel, "outside survives");
	const link = join(outDir, "nested", "outside-link");
	symlinkSync(outside, link, "dir");
	symlinkSync(sentinel, join(outDir, "file-link"), "file");
	symlinkSync(join(outside, "missing"), join(outDir, "dangling-link"), "file");
	assert.equal(lstatSync(link).isSymbolicLink(), true);
	const artifactSet = produceArtifactSet({ repoRoot, outDir, build: false, force: true, source: { commit: "fixture", dirty: false } });
	assert.deepEqual(artifactSet.packages, []);
	assert.equal(lstatSync(link, { throwIfNoEntry: false }), undefined);
	assert.equal(lstatSync(join(outDir, "file-link"), { throwIfNoEntry: false }), undefined);
	assert.equal(lstatSync(join(outDir, "dangling-link"), { throwIfNoEntry: false }), undefined);
	assert.equal(readFileSync(sentinel, "utf8"), "outside survives");
	assert.equal(lstatSync(outside).isDirectory(), true);
});

test("produces a verified, content-addressed artifact set", (t) => {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-package-artifacts-test-"));
	t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
	const repoRoot = join(temporaryRoot, "repo with spaces");
	mkdirSync(repoRoot);
	writeFileSync(join(repoRoot, "package.json"), '{"name":"fixture","private":true}\n');
	writePackage(
		join(repoRoot, "packages", "shared"),
		{ name: "@pi-package-test/shared", version: "1.0.0", files: ["dist"] },
		{ "dist/index.js": 'export const marker = "artifact";\n' },
	);
	writePackage(
		join(repoRoot, "packages", "target"),
		{ name: "@pi-package-test/target", version: "1.0.0", files: ["dist"] },
		{ "dist/index.js": 'export const target = true;\n' },
	);
	execFileSync("git", ["init", "--quiet"], { cwd: repoRoot });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
	execFileSync("git", ["add", "."], { cwd: repoRoot });
	execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repoRoot });

	const artifactSet = produceArtifactSet({ build: false, outDir: join(repoRoot, ".artifacts", "package set"), repoRoot });
	assert.deepEqual(artifactSet.packages.map((pkg) => pkg.name), ["@pi-package-test/shared", "@pi-package-test/target"]);
	for (const pkg of artifactSet.packages) {
		assert.match(pkg.tarball, /-[0-9a-f]{12}\.tgz$/);
		assert.match(pkg.integrity, /^sha512-/);
	}
	assert.equal(artifactSet.source.dirty, false);
	assert.equal(readArtifactSet(artifactSet.manifestPath).packages.length, 2);

	writeFileSync(join(repoRoot, "packages/shared/dist/index.js"), 'export const marker = "changed";\n');
	const changedArtifactSet = produceArtifactSet({ build: false, outDir: join(repoRoot, ".artifacts", "changed package set"), repoRoot });
	assert.notEqual(
		changedArtifactSet.getPackage("@pi-package-test/shared").tarball,
		artifactSet.getPackage("@pi-package-test/shared").tarball,
	);

	appendFileSync(artifactSet.packages[0].tarballPath, "corrupt");
	assert.throws(() => readArtifactSet(artifactSet.manifestPath), /integrity mismatch/);
	const packageJsonPath = join(repoRoot, "packages", "shared", "package.json");
	assert.throws(
		() => produceArtifactSet({ build: false, force: true, outDir: join(repoRoot, "packages", "shared"), repoRoot }),
		/Repository-local output directory must be inside.*\.artifacts/,
	);
	assert.equal(existsSync(packageJsonPath), true);
	assert.throws(
		() => produceArtifactSet({ build: false, force: true, outDir: repoRoot, repoRoot }),
		/repository, its ancestor, or a filesystem root/,
	);
	assert.throws(
		() => produceArtifactSet({ build: false, force: true, outDir: temporaryRoot, repoRoot }),
		/repository, its ancestor, or a filesystem root/,
	);
	assert.throws(
		() => produceArtifactSet({ build: false, force: true, outDir: parse(repoRoot).root, repoRoot }),
		/repository, its ancestor, or a filesystem root/,
	);
});
