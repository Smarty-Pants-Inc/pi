import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const cli = resolve("dist/bundle/cli.js");
const built = resolve("dist");
const fauxPath = resolve("../ai/dist/providers/faux.js");
const socket = join(tmpdir(), `pi-terminal-security-${process.pid}.socket`);
const prefix = process.env.PI_PROOF_PREFIX ?? "green";
const evidence = process.env.TASK_OUT;
type RecordLine = Record<string, unknown>;

const extension = `import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFauxCore, fauxAssistantMessage } from ${JSON.stringify(fauxPath)};
export default function(pi) {
  const scenario = process.env.PI_SECURITY_CASE;
  const mark = name => writeFileSync(join(process.env.PI_SECURITY_DIR, name), "ready");
  const hold = () => new Promise(resolve => setTimeout(resolve, 60000));
  const faux = createFauxCore({ provider: "terminal-security-faux" });
  faux.setResponses([fauxAssistantMessage("offline answer")]);
  pi.registerProvider(faux.provider, { baseUrl: faux.getModel().baseUrl, apiKey: "offline-faux-test-only", api: faux.api, streamSimple: faux.streamSimple, models: faux.models });
  pi.on("session_start", async (_event, ctx) => {
    await pi.setModel(faux.getModel());
    if (scenario === "drain") { mark("start-held"); await ctx.ui.confirm("release startup", "release"); }
    if (scenario === "session_start") { mark("held"); ctx.ui.notify("held"); await hold(); }
    ctx.ui.notify("ready"); mark("ready");
  });
  pi.on("resources_discover", async (_event, ctx) => {
    if (scenario !== "resources_discover") return;
    mark("held"); ctx.ui.notify("held"); await hold();
  });
  pi.registerCommand("hold-command", { handler: async (_args, ctx) => { mark("held"); ctx.ui.notify("held"); await hold(); mark("late-command"); } });
  pi.on("session_shutdown", async (_event, ctx) => { mark("cleanup-start"); await new Promise(resolve => setTimeout(resolve, 200)); mark("cleanup-done"); ctx.ui.notify("cleanup-done"); });
}`;

// This runs the built native SDK/runtime and the production RPC mode in a separate process.
// It intentionally has no ordinary owner: registered replacement is supported here.
const runner = `import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { registerFauxProvider, fauxAssistantMessage } from ${JSON.stringify(resolve("../ai/dist/compat.js"))};
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices } from ${JSON.stringify(join(built, "core/agent-session-runtime.js"))};
import { AuthStorage } from ${JSON.stringify(join(built, "core/auth-storage.js"))};
import { ModelRuntime } from ${JSON.stringify(join(built, "core/model-runtime.js"))};
import { SessionManager } from ${JSON.stringify(join(built, "core/session-manager.js"))};
import { runRpcMode } from ${JSON.stringify(join(built, "modes/rpc/rpc-mode.js"))};
const scenario = process.env.PI_SECURITY_CASE;
const dir = process.env.PI_SECURITY_DIR;
const mark = name => writeFileSync(join(dir, name), "ready");
const faux = registerFauxProvider({ tokenSize: { min: 8 * 1024 * 1024, max: 8 * 1024 * 1024 } });
faux.setResponses([fauxAssistantMessage(scenario === "pressure-run" ? "x".repeat(8 * 1024 * 1024) : "offline answer")]);
const auth = AuthStorage.inMemory();
await auth.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "offline-faux-test-only" }));
const modelRuntime = await ModelRuntime.create({ credentials: auth, modelsPath: null, allowModelNetwork: false });
modelRuntime.registerProvider(faux.getModel().provider, { baseUrl: faux.getModel().baseUrl, api: faux.api, apiKey: "offline-faux-test-only", models: faux.models });
let release, captured;
let replacementRan = false;
const extensionFactory = pi => {
  pi.on("session_start", (_event, ctx) => {
    if (scenario === "pressure-command") pi.appendEntry("large", { payload: "x".repeat(8 * 1024 * 1024) });
    ctx.ui.notify("ready");
  });
  pi.on("agent_settled", async (_event, ctx) => {
    if (scenario !== "replacement") return;
    ctx.ui.notify("held"); await new Promise(resolve => setTimeout(resolve, 60000));
  });
  pi.registerCommand("replace-held", { handler: async (_args, ctx) => { replacementRan = true; mark("replacement-ran"); await ctx.newSession(); } });
  pi.on("message_update", event => { if (scenario === "pressure-run" && event.assistantMessageEvent.type === "text_delta") mark("pressure"); });
  pi.on("message_end", async event => {
    if (scenario !== "alias" || event.message.role !== "assistant") return;
    captured = event.message; mark("held"); await new Promise(resolve => { release = resolve; });
    captured.content[0].text = "late nested mutation";
    captured.content.push({ type: "text", text: "late appended mutation" });
    captured.extra = { late: true }; mark("late-mutation");
  });
  pi.on("session_shutdown", (_event, ctx) => {
    writeFileSync(join(dir, "journal-path"), ctx.sessionManager.getSessionFile()); mark("cleanup-done");
  });
};
const factory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd, agentDir: join(dir, "agent"), modelRuntime, resourceLoaderOptions: { extensionFactories: [extensionFactory], noSkills: true, noPromptTemplates: true, noThemes: true } });
  return { ...await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: faux.getModel(), noTools: true }), services, diagnostics: services.diagnostics };
};
const host = await createAgentSessionRuntime(factory, { cwd: dir, agentDir: join(dir, "agent"), sessionManager: SessionManager.create(dir, dir) });
if (scenario === "pressure-command") { host.session.sessionManager.appendMessage(fauxAssistantMessage("offline seed")); host.session.refreshContext(); }
if (scenario !== "alias") await runRpcMode(host);
else {
  await host.session.bindExtensions({});
  const published = [];
  host.session.subscribe(event => { if (event.type === "message_end") published.push(JSON.stringify(event.message)); });
  const run = host.session.prompt("offline prompt");
  process.stdin.once("data", async () => {
    await host.dispose(); await run;
    const manager = host.session.sessionManager;
    const before = JSON.stringify(manager.getEntries());
    const agentBefore = JSON.stringify(host.session.messages);
    const file = manager.getSessionFile();
    const journalBefore = readFileSync(file, "utf8");
    mark("disposed"); release();
    await new Promise(resolve => setImmediate(resolve));
    process.stdout.write(JSON.stringify({ type: "alias-proof", disposed: true, historyStable: before === JSON.stringify(manager.getEntries()), agentStable: agentBefore === JSON.stringify(host.session.messages), journalStable: journalBefore === readFileSync(file, "utf8"), published, history: manager.getEntries(), replacementRan }) + "\\n");
    process.exit(0);
  });
}
`;

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
function tmux(...args: string[]): string {
	return execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}
const tmuxAvailable = (() => {
	try {
		execFileSync("tmux", ["-V"]);
		return true;
	} catch {
		return false;
	}
})();

// smarty-dev#3048 / PR #116 R1-S1..S5: real built CLI, native runtime, pipe and PTY paths.
describe.skipIf(!existsSync(cli))("terminal security process regressions", () => {
	const cleanups: Array<() => Promise<void>> = [];
	let sequence = 0;
	afterEach(async () => {
		while (cleanups.length) await cleanups.pop()?.();
	});
	afterAll(() => {
		if (tmuxAvailable) {
			try {
				tmux("kill-server");
			} catch {}
			rmSync(socket, { force: true });
		}
	});

	async function launch(scenario: string, native = false) {
		const dir = mkdtempSync(join(tmpdir(), "pi-terminal-security-"));
		mkdirSync(join(dir, "agent"));
		writeFileSync(join(dir, "fixture.mjs"), native ? runner : extension);
		const label = `${prefix}-${++sequence}-${scenario}`;
		const env = {
			PATH: process.env.PATH,
			HOME: dir,
			USERPROFILE: dir,
			TMPDIR: dir,
			PI_CODING_AGENT_DIR: join(dir, "agent"),
			PI_OFFLINE: "1",
			PI_PACKAGE_DIR: resolve("."),
			PI_NO_LOCAL_LLM: "1",
			AWS_EC2_METADATA_DISABLED: "true",
			PI_SECURITY_CASE: scenario,
			PI_SECURITY_DIR: dir,
		};
		const child = spawn(
			process.execPath,
			native
				? [join(dir, "fixture.mjs")]
				: [
						cli,
						"--offline",
						"--mode",
						"rpc",
						"--no-session",
						"--no-tools",
						"--no-extensions",
						"--no-skills",
						"--no-prompt-templates",
						"-e",
						join(dir, "fixture.mjs"),
					],
			{ cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] },
		);
		let stdout = "",
			stderr = "",
			framed = "";
		const records: RecordLine[] = [];
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
			framed += chunk;
			let boundary = framed.indexOf("\n");
			while (boundary !== -1) {
				const line = framed.slice(0, boundary);
				framed = framed.slice(boundary + 1);
				if (line.trim()) records.push(JSON.parse(line) as RecordLine);
				boundary = framed.indexOf("\n");
			}
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.stdin.on("error", () => {});
		const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, failed) => {
			child.once("error", failed);
			child.once("exit", (code, signal) => done({ code, signal }));
		});
		const closed = new Promise<void>((done) => child.once("close", () => done()));
		cleanups.push(async () => {
			child.stdin.end();
			child.stdout.resume();
			const timer = setTimeout(() => child.kill("SIGKILL"), 500);
			try {
				const result = await exited;
				await closed;
				if (evidence) {
					writeFileSync(join(evidence, `security-${label}.jsonl`), stdout);
					writeFileSync(join(evidence, `security-${label}.stderr.log`), stderr);
					writeFileSync(join(evidence, `security-${label}.exit.json`), JSON.stringify(result));
					const journalPath = join(dir, "journal-path");
					if (existsSync(journalPath)) {
						const journal = readFileSync(journalPath, "utf8");
						if (existsSync(journal))
							writeFileSync(join(evidence, `security-${label}.journal.jsonl`), readFileSync(journal));
					}
				}
			} finally {
				clearTimeout(timer);
				rmSync(dir, { recursive: true, force: true });
			}
		});
		const send = (command: RecordLine) => child.stdin.write(`${JSON.stringify(command)}\n`);
		const wait = async (predicate: (record: RecordLine) => boolean) => {
			await vi.waitFor(() => expect(records.some(predicate), stderr).toBe(true), { timeout: 10000 });
			return records.find(predicate)!;
		};
		const mark = async (name: string) => {
			await vi.waitFor(() => expect(existsSync(join(dir, name)), `${name}: ${stderr}`).toBe(true), {
				timeout: 10000,
			});
		};
		const exit = async () => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				return await Promise.race([
					exited,
					new Promise((done) => {
						timer = setTimeout(() => done("hung"), 2500);
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
		};
		return { child, dir, env, records, send, wait, mark, exit, stderr: () => stderr };
	}

	it.each(["EOF", "SIGTERM", "SIGHUP"] as const)(
		"R1-S1: deferred registered replacement is cancelled under %s",
		async (ending) => {
			const p = await launch("replacement", true);
			await p.wait((record) => record.message === "ready");
			p.send({ id: "run", type: "prompt", message: "offline prompt" });
			await p.wait((record) => record.message === "held");
			p.send({ id: "replace", type: "prompt", message: "/replace-held" });
			p.send({ id: "barrier", type: "get_state" });
			await p.wait((record) => record.id === "barrier");
			if (ending === "EOF") p.child.stdin.end();
			else p.child.kill(ending);
			expect(await p.exit()).toEqual({
				code: ending === "EOF" ? 0 : ending === "SIGTERM" ? 143 : 129,
				signal: null,
			});
			expect(existsSync(join(p.dir, "replacement-ran"))).toBe(false);
			const responses = p.records.filter((record) => record.id === "replace");
			expect(responses).toHaveLength(1);
			expect(responses[0].success).toBe(false);
			expect(responses[0].error).toMatch(/cancel/i);
			expect(existsSync(join(p.dir, "cleanup-done"))).toBe(true);
		},
	);

	it.each(
		["session_start", "resources_discover", "drain"].flatMap((hook) =>
			["EOF", "overflow"].map((ending) => ({ hook, ending })),
		),
	)("R1-S2: held $hook is cancelled on startup $ending", async ({ hook, ending }) => {
		const p = await launch(hook);
		if (hook === "drain") {
			const dialog = await p.wait((record) => record.method === "confirm");
			p.send({ id: "held-command", type: "prompt", message: "/hold-command" });
			p.send({ type: "extension_ui_response", id: dialog.id, confirmed: true });
		}
		await p.mark("held");
		p.send({ id: "buffered-a", type: "get_state" });
		p.send({ id: "buffered-b", type: "get_state" });
		if (ending === "overflow")
			for (let index = 0; index < 257; index++) p.send({ id: `fill-${index}`, type: "get_state" });
		p.child.stdin.end();
		expect(await p.exit()).toEqual({ code: ending === "overflow" ? 1 : 0, signal: null });
		expect(existsSync(join(p.dir, "cleanup-done"))).toBe(true);
		for (const id of ["buffered-a", "buffered-b", ...(hook === "drain" ? ["held-command"] : [])]) {
			const responses = p.records.filter((record) => record.id === id);
			expect(responses, id).toHaveLength(1);
			if (hook !== "drain" || id === "held-command") {
				expect(responses[0].success).toBe(false);
				expect(responses[0].error).toMatch(/cancel/i);
			}
		}
		if (ending === "overflow") expect(p.records.some((record) => record.fatal === true)).toBe(true);
		expect(existsSync(join(p.dir, "late-command"))).toBe(false);
	});

	it.each(["pressure-run", "pressure-command"])(
		"R1-S3: %s joins and persists under SIGTERM with an unread pipe",
		async (scenario) => {
			const p = await launch(scenario, true);
			await p.wait((record) => record.message === "ready");
			p.child.stdout.pause();
			p.send({
				id: "large",
				type: scenario === "pressure-run" ? "prompt" : "get_entries",
				...(scenario === "pressure-run" ? { message: "offline prompt" } : {}),
			});
			if (scenario === "pressure-run") await p.mark("pressure");
			await new Promise((done) => setTimeout(done, 200));
			p.child.kill("SIGTERM");
			expect(await p.exit()).toEqual({ code: 143, signal: null });
			expect(existsSync(join(p.dir, "cleanup-done"))).toBe(true);
			expect(p.stderr()).toContain("RPC output delivery incomplete");
			const journal = readFileSync(readFileSync(join(p.dir, "journal-path"), "utf8"), "utf8");
			expect(journal).toContain(scenario === "pressure-run" ? '"role":"assistant"' : '"customType":"large"');
		},
	);

	it("R1-S4: abandoned nested in-place mutation cannot change disposed canonical history", async () => {
		const p = await launch("alias", true);
		await p.mark("held");
		p.child.stdin.write("dispose\n");
		const proof = await p.wait((record) => record.type === "alias-proof");
		expect(await p.exit()).toEqual({ code: 0, signal: null });
		expect(proof).toMatchObject({ disposed: true, historyStable: true, agentStable: true, journalStable: true });
		expect(JSON.stringify(proof.history)).not.toContain("late nested mutation");
		expect(JSON.stringify(proof.history)).not.toContain("late appended mutation");
		expect(existsSync(join(p.dir, "late-mutation"))).toBe(true);
	});

	it
		.skipIf(!tmuxAvailable)
		.each(
			["session_start", "resources_discover"].flatMap((hook) =>
				["SIGTERM", "SIGHUP"].map((signal) => ({ hook, signal })),
			),
		)("R1-S5: TUI held $hook joins asynchronous cleanup under $signal", async ({ hook, signal }) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-terminal-security-tui-"));
		mkdirSync(join(dir, "agent"));
		writeFileSync(join(dir, "fixture.mjs"), extension);
		const name = `${prefix}-${++sequence}-${hook}-${signal}`;
		tmux("new-session", "-d", "-s", name, "-x", "100", "-y", "30", "-c", dir);
		const ansi = join(evidence ?? dir, `security-tui-${name}.ansi.log`);
		tmux("pipe-pane", "-t", name, "-o", `cat > ${shellQuote(ansi)}`);
		const env = {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			TERM: "tmux-256color",
			LANG: "C.UTF-8",
			HOME: dir,
			TMPDIR: dir,
			PI_CODING_AGENT_DIR: join(dir, "agent"),
			PI_OFFLINE: "1",
			PI_PACKAGE_DIR: resolve("."),
			PI_NO_LOCAL_LLM: "1",
			PI_SECURITY_CASE: hook,
			PI_SECURITY_DIR: dir,
		};
		const command = `set +m; env -i ${Object.entries(env)
			.map(([key, value]) => `${key}=${shellQuote(value)}`)
			.join(
				" ",
			)} nice -n 19 ${shellQuote(process.execPath)} ${[cli, "--offline", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates", "-e", join(dir, "fixture.mjs")].map(shellQuote).join(" ")} </dev/tty & child=$!; echo "$child" > ${shellQuote(join(dir, "pid"))}; wait "$child"; echo "$?" > ${shellQuote(join(dir, "exit"))}`;
		writeFileSync(join(dir, "launch.sh"), `${command}\n`);
		cleanups.push(async () => {
			if (!existsSync(join(dir, "exit")) && existsSync(join(dir, "pid"))) {
				try {
					process.kill(Number(readFileSync(join(dir, "pid"), "utf8")), "SIGKILL");
				} catch {}
				await vi.waitFor(() => expect(existsSync(join(dir, "exit"))).toBe(true), { timeout: 3000 });
			}
			if (evidence) {
				for (const file of ["cleanup-start", "cleanup-done", "exit"])
					if (existsSync(join(dir, file)))
						writeFileSync(join(evidence, `security-tui-${name}-${file}.proof`), readFileSync(join(dir, file)));
			}
			tmux("kill-session", "-t", name);
			rmSync(dir, { recursive: true, force: true });
		});
		tmux("send-keys", "-t", name, "-l", `bash ${shellQuote(join(dir, "launch.sh"))}`);
		tmux("send-keys", "-t", name, "Enter");
		await vi.waitFor(() => expect(existsSync(join(dir, "held"))).toBe(true), { timeout: 10000 });
		process.kill(Number(readFileSync(join(dir, "pid"), "utf8")), signal as NodeJS.Signals);
		await vi.waitFor(() => expect(existsSync(join(dir, "exit"))).toBe(true), { timeout: 5000 });
		expect(Number(readFileSync(join(dir, "exit"), "utf8"))).toBe(0);
		expect(existsSync(join(dir, "cleanup-start"))).toBe(true);
		expect(existsSync(join(dir, "cleanup-done"))).toBe(true);
		await vi.waitFor(() => expect(readFileSync(ansi, "utf8")).toContain("\u001b[?25h"));
		expect(readFileSync(ansi, "utf8")).not.toContain("uncaughtException");
	});
});
