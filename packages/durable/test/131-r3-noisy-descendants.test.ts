import type * as Fs from "node:fs";
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it, vi } from "vitest";
import { NodeExecutionEnv } from "../src/env/node.ts";
import type { ToolExecutionApi } from "../src/harness/types.ts";
import { createBashTool } from "../src/tools/bash.ts";

vi.setConfig({ testTimeout: 20_000 });

const spill = vi.hoisted(() => ({
	mode: "normal" as "normal" | "slow" | "blocked",
	rejectedWrites: 0,
	pending: [] as (() => void)[],
}));

// Real private files, with deterministic backpressure. No filesystem cleanup is invoked.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof Fs>();
	return {
		...actual,
		createWriteStream: (path: Fs.PathLike, options?: Parameters<typeof Fs.createWriteStream>[1]) => {
			const mode = spill.mode;
			const stream = actual.createWriteStream(path, {
				...(typeof options === "object" ? options : {}),
				...(mode === "normal" ? {} : { highWaterMark: 1 }),
			});
			if (mode !== "normal") {
				const writeChunk = stream._write.bind(stream);
				stream._write = (chunk, encoding, callback) => {
					if (spill.mode === "normal") writeChunk(chunk, encoding, callback);
					else if (mode === "blocked") spill.pending.push(() => callback());
					else setTimeout(() => writeChunk(chunk, encoding, callback), 600);
				};
				const writeChunks = stream._writev?.bind(stream);
				if (writeChunks !== undefined) {
					stream._writev = (chunks, callback) => {
						if (spill.mode === "normal") writeChunks(chunks, callback);
						else if (mode === "blocked") spill.pending.push(() => callback());
						else setTimeout(() => writeChunks(chunks, callback), 600);
					};
				}
			}
			const write = stream.write.bind(stream);
			stream.write = ((...args: Parameters<Fs.WriteStream["write"]>) => {
				const accepted = Reflect.apply(write, stream, args) as boolean;
				if (!accepted) spill.rejectedWrites++;
				return accepted;
			}) as Fs.WriteStream["write"];
			return stream;
		},
	};
});

function quote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function liveGroup(pgid: number): Promise<number[]> {
	const live: number[] = [];
	for (const name of await readdir("/proc")) {
		if (!/^\d+$/.test(name)) continue;
		let text: string;
		try {
			text = await readFile(`/proc/${name}/stat`, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
		if (Number(fields[2]) === pgid && fields[0] !== "Z" && fields[0] !== "X") live.push(Number(name));
	}
	return live;
}

async function runOwned(command: (root: string) => string, mode: typeof spill.mode, expectFailure = false) {
	spill.mode = mode;
	spill.rejectedWrites = 0;
	const root = await mkdtemp(join(tmpdir(), "pi-131-f08-"));
	const env = new NodeExecutionEnv({ cwd: root, shellPath: "/bin/bash" });
	let bytes = 0;
	let stdout = false;
	let stderr = false;
	const diagnostics: string[] = [];
	// Deliberately strict fake: this native tool uses only these three API operations.
	const api = new Proxy(
		{
			env,
			output: (text: string | Uint8Array) => {
				const value = typeof text === "string" ? text : new TextDecoder().decode(text);
				bytes += value.length;
				stdout ||= value.includes("OUT");
				stderr ||= value.includes("ERR");
			},
			diagnostic: (value: { message: string }) => diagnostics.push(value.message),
		},
		{
			get(target, key, receiver) {
				if (!(key in target)) throw new Error(`Unexpected fake API access: ${String(key)}`);
				return Reflect.get(target, key, receiver);
			},
		},
	) as unknown as ToolExecutionApi;
	const start = Date.now();
	const execution = createBashTool().execute(
		{ command: `echo $$ > ${quote(join(root, "leader.pid"))}; ${command(root)}` },
		api,
		BACKGROUND_CONTEXT,
	);
	// Immediately own both success and failure; the watchdog is not product success.
	const observed = execution.then(
		() => ({ error: undefined, bytesAtSettlement: bytes }),
		(error: unknown) => ({ error, bytesAtSettlement: bytes }),
	);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const outcome = await Promise.race([
			observed,
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), 4000);
			}),
		]);
		if (timer !== undefined) clearTimeout(timer);
		const pgid = Number((await readFile(join(root, "leader.pid"), "utf8")).trim());
		expect(Number.isSafeInteger(pgid) && pgid > 1).toBe(true);
		const elapsed = Date.now() - start;
		const liveAtSettlement = await liveGroup(pgid);
		if (outcome === undefined) {
			console.error(
				`PRODUCT WATCHDOG: native Bash pending after ${elapsed}ms; pgid=${pgid}; live=${liveAtSettlement}; bytes=${bytes}; backpressure=${spill.rejectedWrites}`,
			);
			try {
				process.kill(-pgid, "SIGKILL");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		}
		// Release only test-injected blocked callbacks and join all product work, even on RED.
		spill.mode = "normal";
		for (const release of spill.pending.splice(0)) release();
		await observed;
		await env.cleanup(BACKGROUND_CONTEXT);
		const bytesAtSettlement = bytes;
		const spillPath = diagnostics.find((value) => value.startsWith("Full output: "))?.slice("Full output: ".length);
		const spillSize = spillPath === undefined ? undefined : (await stat(spillPath)).size;
		await new Promise<void>((resolve) => setTimeout(resolve, 150));
		expect(await liveGroup(pgid)).toEqual([]);
		expect(bytes).toBe(bytesAtSettlement);
		if (spillPath !== undefined) expect((await stat(spillPath)).size).toBe(spillSize);
		expect(outcome, "native Bash must settle without test-owned group retirement").toBeDefined();
		expect(bytes, "no callback output after product settlement").toBe(outcome?.bytesAtSettlement);
		expect(liveAtSettlement, "product settlement must follow group retirement/join").toEqual([]);
		if (expectFailure) expect(String(outcome?.error)).toContain("Failed to preserve complete shell output");
		else expect(outcome?.error).toBeUndefined();
		console.log(
			`F08 receipt: mode=${mode}; elapsed=${elapsed}ms; bytes=${bytes}; backpressure=${spill.rejectedWrites}; retired=true; stable-output=true`,
		);
		return { bytes, stdout, stderr, spillPath, rejectedWrites: spill.rejectedWrites };
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		spill.mode = "normal";
		for (const release of spill.pending.splice(0)) release();
		// Also join on unexpected fixture/assertion failure; this process-only cleanup deletes no files.
		await env.cleanup(BACKGROUND_CONTEXT);
		await observed;
	}
}

// PR #131 F08 / Security R2-8: omitted-timeout native Bash, not a guest or unsupported transport.
describe.skipIf(process.platform !== "linux")("PR #131 noisy same-group descendants", () => {
	it.each(["stdout", "stderr"] as const)("bounds continuous %s after leader exit", async (stream) => {
		const result = await runOwned(
			() =>
				`(while :; do printf '${stream === "stdout" ? "OUT" : "ERR"}\\n' ${stream === "stderr" ? ">&2" : ""}; sleep 0.02; done) &`,
			"normal",
		);
		expect(result[stream]).toBe(true);
	});

	it.each(["normal", "slow"] as const)("retires both noisy pipes with %s spill drainage", async (mode) => {
		const result = await runOwned(
			() => "(while :; do printf 'OUT%04096d\\n' 0; printf 'ERR%04096d\\n' 0 >&2; sleep 0.02; done) &",
			mode,
		);
		expect(result.stdout && result.stderr).toBe(true);
		expect(result.spillPath).toBeDefined();
		if (mode === "slow") expect(result.rejectedWrites).toBeGreaterThan(0);
	});

	it("bounds accepted spill drain when the writer never drains", async () => {
		const result = await runOwned(
			() => "(while :; do printf 'OUT%060000d\\n' 0; printf 'ERR%060000d\\n' 0 >&2; sleep 0.02; done) &",
			"blocked",
			true,
		);
		expect(result.rejectedWrites).toBeGreaterThan(0);
	});

	it.each(["sleep 60 &", "sleep 60 >/dev/null 2>&1 &"])(
		"preserves quiet/closed-pipe retirement: %s",
		async (command) => {
			await runOwned(() => command, "normal");
		},
	);

	it("preserves delayed finite output under legitimate spill backpressure", async () => {
		// Mirrors the credited 600ms-spill / 200ms-descendant control without its deleting afterEach.
		const result = await runOwned(() => "printf 'OUT%060000d' 0; (sleep 0.2; printf 'ERR%01000d' 0) &", "slow");
		expect(result.stdout && result.stderr).toBe(true);
		expect(result.bytes).toBe(61006);
		expect(result.spillPath).toBeDefined();
		expect((await readFile(result.spillPath!, "utf8")).length).toBe(61006);
	});

	it("preserves complete finite multi-megabyte output", async () => {
		const result = await runOwned(
			() =>
				`${quote(process.execPath)} -e 'process.stdout.write("OUT"+"x".repeat(3000000));process.stderr.write("ERR")'`,
			"normal",
		);
		expect(result.bytes).toBe(3000006);
		expect((await readFile(result.spillPath!, "utf8")).length).toBe(3000006);
	});
});
