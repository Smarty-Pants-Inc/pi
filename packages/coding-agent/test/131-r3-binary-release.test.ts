import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { refuseUnreviewedBuiltin } from "../src/core/builtin-security-admission.ts";

const root = resolve(import.meta.dirname, "../../..");

async function post(url: string, body: unknown): Promise<string> {
	return new Promise((resolveResponse, reject) => {
		const req = request(url, { method: "POST", headers: { "content-type": "application/json" } }, (res) => {
			let data = "";
			res.on("data", (chunk) => {
				data += chunk.toString();
			});
			res.on("end", () => resolveResponse(data));
			res.on("error", reject);
		});
		req.on("error", reject);
		req.end(JSON.stringify(body));
	});
}

interface SmokeOptions {
	allowRefused?: boolean;
	mutateConfig?: boolean;
	networkDuringRefusal?: boolean;
	guestDuringRefusal?: boolean;
	nativeResult?: string;
}

async function exerciseSmoke(options: SmokeOptions = {}) {
	const source = await readFile(join(root, "scripts/smoke-test-codemode-binary.mjs"), "utf8");
	const calls: string[][] = [];
	const effects: string[] = [];
	const children: Promise<void>[] = [];
	let stdout = "";
	// Execute orchestration with a faux binary, never the deletion-bearing script as a subprocess.
	// Filesystem removal is inert even on the reviewed baseline; all scratch is launcher-owned.
	const spawn = (_binary: string, args: string[], childOptions: { cwd: string }) => {
		calls.push(args);
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			kill: () => false,
		});
		const work = new Promise<void>((done) => {
			setImmediate(async () => {
				try {
					const builtin = args.find((arg) => arg.startsWith("builtin:"));
					if (builtin || args[0] === "mcp") {
						if (options.mutateConfig) await writeFile(join(childOptions.cwd, "mcp.json"), "mutated");
						if (options.guestDuringRefusal)
							await writeFile(join(childOptions.cwd, "guest-effect.txt"), "unexpected guest");
						if (options.networkDuringRefusal) {
							const models = JSON.parse(await readFile(join(childOptions.cwd, "models.json"), "utf8"));
							await post(`${models.providers["native-smoke"].baseUrl}/mcp`, {});
						}
						if (!options.allowRefused)
							refuseUnreviewedBuiltin(builtin === "builtin:codemode" ? "codemode" : "mcp");
						child.emit("close", 0);
						child.emit("exit", 0);
						return;
					}
					const models = JSON.parse(await readFile(join(childOptions.cwd, "models.json"), "utf8"));
					const provider = args[args.indexOf("--provider") + 1];
					const endpoint = `${models.providers[provider].baseUrl}/chat/completions`;
					const first = await post(endpoint, {
						messages: [],
						tools: [{ type: "function", function: { name: "read" } }],
					});
					const chunks = first
						.split("\n")
						.filter((line) => line.startsWith("data: {"))
						.map((line) => JSON.parse(line.slice(6)));
					const tool = chunks.flatMap((chunk) => chunk.choices[0].delta.tool_calls ?? [])[0].function;
					// Mirrors the shipping cut: the faux binary can read, but cannot execute a Codemode guest.
					const content =
						tool.name === "read"
							? (options.nativeResult ??
								(await readFile(join(childOptions.cwd, JSON.parse(tool.arguments).path), "utf8")))
							: "Tool codemode not found";
					if (tool.name !== "read") effects.push("refused guest");
					const second = await post(endpoint, { messages: [{ role: "tool", content }] });
					for (const line of second.split("\n").filter((line) => line.startsWith("data: {"))) {
						const text = JSON.parse(line.slice(6)).choices[0].delta.content;
						if (text) child.stdout.write(text);
					}
					child.stdout.end();
					child.stderr.end();
					child.emit("close", 0);
					child.emit("exit", 0);
				} catch (error) {
					child.stderr.end(error instanceof Error ? error.message : String(error));
					child.stdout.end();
					child.emit("close", 1);
					child.emit("exit", 1);
				} finally {
					done();
				}
			});
		});
		children.push(work);
		return child;
	};
	const body = source
		.replace(/^#!.*\n/, "")
		.replace(/^import .*;\n/gm, "")
		.replace(/main\(\)\.catch\([\s\S]*$/, "return main();");
	let failure: unknown;
	try {
		await runInNewContext(`(async () => { ${body} })()`, {
			spawn,
			mkdtemp,
			writeFile,
			readFile,
			readdir,
			rm: async () => {
				effects.push("baseline cleanup suppressed");
			},
			createServer,
			tmpdir,
			extname,
			join,
			resolve,
			setTimeout,
			clearTimeout,
			Buffer,
			process: {
				argv: [process.execPath, "smoke.mjs", "/faux/pi"],
				execPath: process.execPath,
				env: { TMPDIR: process.env.TMPDIR },
				stdout: {
					write: (text: string) => {
						stdout += text;
					},
				},
			},
		});
	} catch (error) {
		failure = error;
	} finally {
		await Promise.all(children);
	}
	return { failure, calls, stdout, effects };
}

describe("PR #131 round-3 binary release", () => {
	// PR #131 F23: execute the package-local prerequisite orchestration, not a root-build rescue.
	it("runs every required compiled-package prerequisite before bundling", async () => {
		const scratch = await mkdtemp(join(tmpdir(), "pi-131-build-graph-"));
		const recorder = join(scratch, "record.cjs");
		await writeFile(recorder, "console.log(JSON.stringify(process.argv.slice(2)));\n");
		for (const command of ["npm", "bun"]) {
			const path = join(scratch, command);
			await writeFile(path, `#!/bin/sh\nexec '${process.execPath}' '${recorder}' "$@"\n`);
			await chmod(path, 0o700);
		}
		const metadata = JSON.parse(await readFile(join(root, "packages/coding-agent/package.json"), "utf8"));
		const result = spawnSync("/bin/sh", ["-c", metadata.scripts["build:binary"]], {
			cwd: join(root, "packages/coding-agent"),
			encoding: "utf8",
			timeout: 10000,
			env: { PATH: `${scratch}:${process.env.PATH}`, TMPDIR: process.env.TMPDIR },
		});
		expect(result.status, result.stderr).toBe(0);
		const trace: string[][] = result.stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const bundle = trace.findIndex((args) => args.join(" ") === "run build");
		const prerequisites = trace.slice(0, bundle).map((args) => args[1]);
		expect(prerequisites).toEqual([
			"../chord",
			"../tui",
			"../telemetry",
			"../codemode",
			"../mcp",
			"../ai",
			"../agent",
			"../protocol",
			"../client",
		]);
		const compile = trace.find((args) => args.includes("--compile"));
		expect(compile).toContain("--tsconfig");
		expect(compile).toContain("../../tsconfig.base.json");
	});

	// PR #131 F24: mandatory release smoke must accept the shipped cut, not demand a guest.
	it("accepts native read success and verifies Codemode/MCP rejection", async () => {
		const result = await exerciseSmoke();
		expect(result.failure === undefined, String(result.failure)).toBe(true);
		expect(result.stdout).toContain("PI_NATIVE_BINARY_SMOKE_OK");
		expect(result.calls.some((args) => args.includes("builtin:codemode"))).toBe(true);
		expect(result.calls.some((args) => args.includes("builtin:mcp"))).toBe(true);
		expect(result.calls.some((args) => args[0] === "mcp" && args.includes("add"))).toBe(true);
		expect(result.effects).toEqual([]);
	});

	// PR #131 F24 controls: a smoke gate must fail when its binary violates the cut or tool path.
	it("rejects a binary that admits a disabled builtin", async () => {
		const result = await exerciseSmoke({ allowRefused: true });
		expect(String(result.failure)).toContain("rejection");
	});
	it("rejects configuration effects during MCP refusal", async () => {
		const result = await exerciseSmoke({ mutateConfig: true });
		expect(String(result.failure)).toContain("configuration");
	});
	// PR #131 F24: rejection alone is insufficient if a guest or network request escaped first.
	it("rejects guest artifacts even when the CLI reports refusal", async () => {
		const result = await exerciseSmoke({ guestDuringRefusal: true });
		expect(String(result.failure)).toContain("guest/process artifact");
	});
	it("rejects network effects even when the CLI reports refusal", async () => {
		const result = await exerciseSmoke({ networkDuringRefusal: true });
		expect(String(result.failure)).toContain("requests 1");
	});
	it("requires the native tool result, not just a model success string", async () => {
		const result = await exerciseSmoke({ nativeResult: "missing native marker" });
		expect(result.failure).toBeDefined();
	});

	it("keeps compiled worker resolution and staging dependent on smoke", async () => {
		const bundle = await readFile(join(root, "scripts/build-coding-agent-bundle.mjs"), "utf8");
		expect(bundle).toContain("tsconfigRaw: { compilerOptions: {} }");
		expect(bundle).toContain('"codemode-worker": join(codingAgentDistDir, "extensions", "codemode", "worker.js")');
		const workflow = await readFile(join(root, ".github/workflows/build-binaries.yml"), "utf8");
		expect(workflow).toMatch(/stage-github-release:[\s\S]*?needs:\s*- build\s*- smoke-test-binaries/);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expressions are literal workflow text.
		expect(workflow).toContain('node scripts/smoke-test-codemode-binary.mjs "${{ steps.binary.outputs.binary }}"');
	});
});
