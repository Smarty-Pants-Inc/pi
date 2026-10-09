import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const built = process.env.PI_R1_DIST ?? resolve("dist");
const evidence = process.env.TASK_OUT;
const prefix = process.env.PI_PROOF_PREFIX ?? "green";
type RecordLine = Record<string, unknown>;

// pi#117 R1: native built SDK + production RPC, offline faux provider, no mocked lifecycle.
const runner = `import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerFauxProvider, fauxAssistantMessage } from ${JSON.stringify(resolve("../ai/dist/compat.js"))};
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices } from ${JSON.stringify(join(built, "core/agent-session-runtime.js"))};
import { AuthStorage } from ${JSON.stringify(join(built, "core/auth-storage.js"))};
import { ModelRuntime } from ${JSON.stringify(join(built, "core/model-runtime.js"))};
import { SessionManager } from ${JSON.stringify(join(built, "core/session-manager.js"))};
import { runRpcMode } from ${JSON.stringify(join(built, "modes/rpc/rpc-mode.js"))};
const dir = process.env.PI_R1_DIR, scenario = process.env.PI_R1_CASE;
const mark = name => writeFileSync(join(dir, name), "ready");
const hold = name => new Promise(resolve => { const timer = setInterval(() => { if (existsSync(join(dir, "release-" + name))) { clearInterval(timer); resolve(); } }, 10); });
const publish = data => process.stdout.write(JSON.stringify(data) + "\\n");
const faux = registerFauxProvider();
faux.setResponses(Array.from({ length: 6 }, () => fauxAssistantMessage("offline answer")));
const auth = AuthStorage.inMemory();
await auth.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "offline-faux-test-only" }));
const modelRuntime = await ModelRuntime.create({ credentials: auth, modelsPath: null, allowModelNetwork: false });
modelRuntime.registerProvider(faux.getModel().provider, { baseUrl: faux.getModel().baseUrl, api: faux.api, apiKey: "offline-faux-test-only", models: faux.models });
let starts = 0, seed, settlementReleased = false;
const factory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const extensionFactory = pi => {
    pi.on("session_start", (_event, ctx) => { starts++; ctx.ui.notify("ready"); if (starts === 2 && scenario === "retired-shutdown") { ctx.shutdown(); mark("shutdown-requested"); } });
    pi.on("session_shutdown", async event => { if (event.reason !== "quit") return; mark("cleanup-start"); if (scenario === "client-budget") await new Promise(resolve => setTimeout(resolve, 700)); mark("cleanup-done"); });
    pi.on("agent_settled", async () => { if (scenario !== "custom-callback" || settlementReleased) return; mark("settlement-held"); await hold("settlement"); settlementReleased = true; });
    pi.on("session_before_tree", async () => { if (scenario !== "tree-before") return; mark("tree-held"); await hold("tree"); mark("tree-returned"); return { label: "must-not-commit" }; });
    pi.on("session_tree", async () => { if (scenario !== "tree-after") return; mark("tree-held"); await hold("tree"); mark("tree-returned"); });
    pi.registerCommand("held", { handler: async (_args, ctx) => { mark("command-held"); ctx.ui.notify("command-held"); if (scenario === "self-shutdown") { ctx.shutdown(); mark("shutdown-requested"); } await hold("command"); } });
  };
  const services = await createAgentSessionServices({ cwd, agentDir: join(dir, "agent"), modelRuntime, resourceLoaderOptions: { extensionFactories: [extensionFactory], noSkills: true, noPromptTemplates: true, noThemes: true } });
  return { ...await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: faux.getModel(), noTools: true }), services, diagnostics: services.diagnostics };
};
const host = await createAgentSessionRuntime(factory, { cwd: dir, agentDir: join(dir, "agent"), sessionManager: SessionManager.create(dir, dir) });
if (["retired-shutdown", "self-shutdown", "client-budget"].includes(scenario)) await runRpcMode(host);
else {
  await host.session.bindExtensions({});
  if (scenario === "custom-callback") {
    host.setRebindSession(async session => {
      await session.bindExtensions({}); seed = session.prompt("receiving-seed"); void seed.catch(() => {});
      while (!existsSync(join(dir, "settlement-held"))) await new Promise(resolve => setTimeout(resolve, 10));
    });
    const result = await host.newSession({ withSession: async ctx => {
      mark("callback-active");
      await ctx.sendMessage({ customType: "callback-custom", content: "authoritative custom", display: false }, { triggerTurn: true });
      publish({ type: "callback-result", settlementReleased });
    } });
    await seed.catch(error => publish({ type: "seed-error", error: String(error) }));
    publish({ type: "custom-proof", result, messages: host.session.messages });
  } else if (scenario.startsWith("tree-")) {
    const manager = host.session.sessionManager;
    const target = manager.appendMessage({ role: "user", content: "target", timestamp: 1 });
    manager.appendMessage(fauxAssistantMessage("leaf")); host.session.refreshContext();
    const oldLeaf = manager.getLeafId(), revision = manager.revision();
    const work = host.session.navigateTree(target, { label: "must-not-commit" });
    void work.catch(() => {});
    while (!existsSync(join(dir, "tree-held"))) await new Promise(resolve => setTimeout(resolve, 10));
    host.session.abortBranchSummary();
    let timer; const result = await Promise.race([work, new Promise(resolve => { timer = setTimeout(() => resolve("hung"), 200); })]); clearTimeout(timer);
    const afterCancel = { busy: host.session.isCompacting, leaf: manager.getLeafId(), revision: manager.revision() };
    writeFileSync(join(dir, "release-tree"), "release"); await work.catch(() => {});
    while (!existsSync(join(dir, "tree-returned"))) await new Promise(resolve => setTimeout(resolve, 10));
    await new Promise(resolve => setImmediate(resolve));
    publish({ type: "tree-proof", result, afterCancel, oldLeaf, revision, leaf: manager.getLeafId(), finalRevision: manager.revision() });
  } else {
    if (scenario === "dispose-queued") await host.session.steer("undelivered", [{ type: "image", mimeType: "image/png", data: "original-bytes" }]);
    let error;
    try { await host.dispose({ terminal: true, beforeShutdown: async () => mark("before-shutdown") }); } catch (cause) { error = String(cause); }
    publish({ type: "dispose-proof", error, disposed: host.session.isDisposed, queued: host.session.agent.getQueuedMessages(), cleanup: existsSync(join(dir, "cleanup-done")), before: existsSync(join(dir, "before-shutdown")) });
    if (scenario === "dispose-queued") {
      const rejected = []; await host.dispose({ terminal: true, rejectQueuedInput: messages => rejected.push(...messages) });
      publish({ type: "retry-proof", disposed: host.session.isDisposed, rejected });
    }
  }
  if (!host.session.isDisposed) await host.dispose({ terminal: true, rejectQueuedInput: () => {} });
  process.exit(0);
}`;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
});

async function launch(scenario: string) {
	const dir = mkdtempSync(join(tmpdir(), "pi-r1-runtime-"));
	mkdirSync(join(dir, "agent"));
	const path = join(dir, "runner.mjs");
	writeFileSync(path, runner);
	const env = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: dir,
		TMPDIR: dir,
		PI_CODING_AGENT_DIR: join(dir, "agent"),
		PI_OFFLINE: "1",
		PI_NO_LOCAL_LLM: "1",
		PI_PACKAGE_DIR: resolve("."),
		PI_R1_DIR: dir,
		PI_R1_CASE: scenario,
	};
	let child: ChildProcessWithoutNullStreams | undefined;
	let client: RpcClient | undefined;
	let stdout = "",
		stderr = "";
	const records: RecordLine[] = [];
	let closed: Promise<void> | undefined;
	if (scenario === "client-budget") {
		client = new RpcClient({ cliPath: path, cwd: dir, env });
		client.onEvent((event) => records.push(event as unknown as RecordLine));
		await client.start();
	} else {
		child = spawn(process.execPath, [path], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
		let framed = "";
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
		closed = new Promise((done) => child!.once("close", () => done()));
	}
	cleanups.push(async () => {
		if (client) await client.stop().catch(() => {});
		if (child) {
			child.stdin.end();
			const timer = setTimeout(() => child!.kill("SIGKILL"), 1000);
			await closed;
			clearTimeout(timer);
		}
		if (evidence) {
			writeFileSync(
				join(evidence, `r1-${prefix}-${scenario}.jsonl`),
				stdout || records.map((record) => JSON.stringify(record)).join("\n"),
			);
			writeFileSync(join(evidence, `r1-${prefix}-${scenario}.stderr.log`), stderr || client?.getStderr() || "");
			for (const name of ["cleanup-start", "cleanup-done", "before-shutdown"])
				if (existsSync(join(dir, name)))
					writeFileSync(join(evidence, `r1-${prefix}-${scenario}-${name}.proof`), readFileSync(join(dir, name)));
		}
		rmSync(dir, { recursive: true, force: true });
	});
	return {
		dir,
		records,
		client,
		send: (command: RecordLine) => child!.stdin.write(`${JSON.stringify(command)}\n`),
		release: (name: string) => writeFileSync(join(dir, `release-${name}`), "release"),
		mark: async (name: string) => {
			await vi.waitFor(() => expect(existsSync(join(dir, name)), `${name}: ${stderr}`).toBe(true), {
				timeout: 8000,
			});
		},
		wait: async (type: string) => {
			await vi.waitFor(
				() =>
					expect(
						records.some((record) => record.type === type),
						stderr,
					).toBe(true),
				{ timeout: 8000 },
			);
			return records.find((record) => record.type === type)!;
		},
		exit: async () => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				return await Promise.race([
					closed!.then(() => ({ code: child!.exitCode, signal: child!.signalCode })),
					new Promise((done) => {
						timer = setTimeout(() => done("hung"), 2500);
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
		},
	};
}

describe.skipIf(!existsSync(join(built, "cli.js")))("PR117 round1 native process regressions", () => {
	it("R1-1: receiving settlement retains awaited withSession custom permission and completion", async () => {
		const p = await launch("custom-callback");
		await p.mark("callback-active");
		await new Promise((done) => setTimeout(done, 100));
		expect(p.records.some((record) => record.type === "callback-result")).toBe(false);
		p.release("settlement");
		expect(await p.wait("callback-result")).toMatchObject({ settlementReleased: true });
		const proof = await p.wait("custom-proof");
		expect(JSON.stringify(proof.messages)).toContain("authoritative custom");
		expect(await p.exit()).toEqual({ code: 0, signal: null });
	});
	it.each(["retired-shutdown", "self-shutdown"])(
		"R1-2: %s cancels retained slash work with stdin open",
		async (scenario) => {
			const p = await launch(scenario);
			p.send({ id: "held", type: "prompt", message: "/held" });
			await p.mark("command-held");
			if (scenario === "retired-shutdown") p.send({ id: "replace", type: "new_session" });
			await p.mark("shutdown-requested");
			expect(await p.exit()).toEqual({ code: 0, signal: null });
			expect(p.records.filter((record) => record.id === "held")).toEqual([
				expect.objectContaining({ success: false, error: expect.stringContaining("INPUT_ADMISSION_SHUTDOWN") }),
			]);
			expect(existsSync(join(p.dir, "cleanup-done"))).toBe(true);
		},
	);
	it("R1-3: real client stop permits server command deadline and asynchronous cleanup", async () => {
		const p = await launch("client-budget");
		const receipt = p.client!.prompt("/held").then(
			() => "success",
			(error: unknown) => String(error),
		);
		await p.mark("command-held");
		await p.client!.newSession();
		await p.client!.stop();
		expect(await receipt).toContain("INPUT_ADMISSION_SHUTDOWN");
		expect(existsSync(join(p.dir, "cleanup-done"))).toBe(true);
	});
	it.each(["before", "after"])(
		"R1-11: ordinary abort releases held tree %s hook without late commit",
		async (phase) => {
			const p = await launch(`tree-${phase}`);
			const proof = await p.wait("tree-proof");
			expect(proof.result).toMatchObject({
				cancelled: phase === "before",
				...(phase === "before" ? { aborted: true } : {}),
			});
			expect(proof.afterCancel).toMatchObject({ busy: false });
			if (phase === "before") expect(proof).toMatchObject({ leaf: proof.oldLeaf, finalRevision: proof.revision });
			else expect(proof.leaf).not.toBe(proof.oldLeaf);
			expect(await p.exit()).toEqual({ code: 0, signal: null });
		},
	);
	it("R1-12: terminal disposal without receipt callback runs empty-runtime cleanup", async () => {
		const p = await launch("dispose-empty");
		expect(await p.wait("dispose-proof")).toMatchObject({ disposed: true, cleanup: true, before: true, queued: [] });
		expect(await p.exit()).toEqual({ code: 0, signal: null });
	});
	it("R1-12: terminal disposal without callback safely refuses undelivered original attachments", async () => {
		const p = await launch("dispose-queued");
		expect(await p.wait("dispose-proof")).toMatchObject({
			disposed: false,
			error: expect.stringContaining("INPUT_ADMISSION_BUSY"),
			queued: [
				expect.objectContaining({
					content: [
						{ type: "text", text: "undelivered" },
						{ type: "image", mimeType: "image/png", data: "original-bytes" },
					],
				}),
			],
		});
		expect(await p.wait("retry-proof")).toMatchObject({
			disposed: true,
			rejected: [expect.objectContaining({ role: "user" })],
		});
		expect(await p.exit()).toEqual({ code: 0, signal: null });
	});
});
