import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const resolver = resolve(__dirname, "../src/experimental/source-resolver.ts");
const guard = resolve(__dirname, "../src/core/output-guard.ts");
const scriptAvailable = process.platform === "linux" && spawnSync("script", ["--version"]).status === 0;
const size = 4 * 1024 * 1024;

// pi#132 R4-5: the exit recovery receipt must not block shutdown on an unread terminal.
describe.skipIf(process.platform === "win32")("writeStdoutBounded exit recovery output", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	async function run(terminal: "pipe" | "pty", read: boolean, prelude = "") {
		const dir = mkdtempSync(join(tmpdir(), "pi-bounded-write-"));
		dirs.push(dir);
		const result = join(dir, "result");
		const entry = join(dir, "writer.mjs");
		writeFileSync(
			entry,
			`import { writeFileSync } from "node:fs";
import { writeRawStdout, writeStdoutBounded } from ${JSON.stringify(guard)};
${prelude}
const result = await writeStdoutBounded("x".repeat(${size}) + "END\\n", ${read ? 10000 : 1000});
writeFileSync(${JSON.stringify(result)}, result);
process.exit(0);
`,
		);
		const node = [process.execPath, "--import", resolver, entry];
		const command =
			terminal === "pty" ? ["script", "-qfec", node.map((arg) => `'${arg}'`).join(" "), "/dev/null"] : node;
		const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "ignore"] });
		let received = 0;
		if (read)
			child.stdout.on("data", (chunk: Buffer) => {
				received += chunk.length;
			});
		const exited = await new Promise<boolean>((done) => {
			const timer = setTimeout(() => done(false), 20000);
			const poll = setInterval(() => {
				try {
					readFileSync(result);
					clearInterval(poll);
					clearTimeout(timer);
					done(true);
				} catch {}
			}, 50);
		});
		child.kill("SIGKILL");
		return { exited, disposition: exited ? readFileSync(result, "utf8") : "", received };
	}

	it.each(["pipe", ...(scriptAvailable ? ["pty"] : [])] as const)(
		"unread %s gets a finite shutdown with an incomplete disposition",
		async (terminal) => {
			const outcome = await run(terminal as "pipe" | "pty", false);
			expect(outcome.exited).toBe(true);
			expect(outcome.disposition).toBe("incomplete");
		},
		30000,
	);

	it.each(["pipe", ...(scriptAvailable ? ["pty"] : [])] as const)(
		"healthy %s receives the whole receipt",
		async (terminal) => {
			const outcome = await run(terminal as "pipe" | "pty", true);
			expect(outcome.exited).toBe(true);
			expect(outcome.disposition).toBe("complete");
			expect(outcome.received).toBeGreaterThanOrEqual(size);
		},
		30000,
	);

	// pi#163 P2 (:114): a prior raw stdout write still backpressured must share the deadline.
	it("a backpressured prior raw write cannot hold shutdown past the deadline", async () => {
		const outcome = await run("pipe", false, `writeRawStdout("y".repeat(${size}));`);
		expect(outcome.exited).toBe(true);
		expect(outcome.disposition).toBe("incomplete");
	}, 30000);
});
