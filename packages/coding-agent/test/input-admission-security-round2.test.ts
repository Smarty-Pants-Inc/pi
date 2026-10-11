import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const built = process.env.PI_R1_DIST ?? resolve("dist");
const evidence = process.env.TASK_OUT;
const prefix = process.env.PI_PROOF_PREFIX ?? "green";
type RecordLine = Record<string, unknown>;

// smarty-dev#3048 / pi#117 R2: actual built SDK, persisted unowned runtime and offline faux provider.
const runner = `import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerFauxProvider, fauxAssistantMessage } from ${JSON.stringify(resolve("../ai/dist/compat.js"))};
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices } from ${JSON.stringify(join(built, "core/agent-session-runtime.js"))};
import { AuthStorage } from ${JSON.stringify(join(built, "core/auth-storage.js"))};
import { ModelRuntime } from ${JSON.stringify(join(built, "core/model-runtime.js"))};
import { SessionManager } from ${JSON.stringify(join(built, "core/session-manager.js"))};
const dir = process.env.PI_R2_DIR, scenario = process.env.PI_R2_CASE;
const mark = name => writeFileSync(join(dir, name), "ready");
const hold = name => new Promise(resolve => { const timer = setInterval(() => { if (existsSync(join(dir, "release-" + name))) { clearInterval(timer); resolve(); } }, 10); });
const publish = data => process.stdout.write(JSON.stringify(data) + "\\n");
const faux = registerFauxProvider();
faux.setResponses(Array.from({ length: 6 }, () => fauxAssistantMessage("offline answer")));
const auth = AuthStorage.inMemory();
await auth.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "offline-faux-test-only" }));
const modelRuntime = await ModelRuntime.create({ credentials: auth, modelsPath: null, allowModelNetwork: false });
modelRuntime.registerProvider(faux.getModel().provider, { baseUrl: faux.getModel().baseUrl, api: faux.api, apiKey: "offline-faux-test-only", models: faux.models });
let host, once = false, requested = false, selfResult, caught, shutdownWork;
const errors = [];
const factory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const extensionFactory = pi => {
    pi.on("session_shutdown", async event => {
      if (event.reason !== "quit") return;
      mark("cleanup-start");
      if (scenario === "cleanup-deadline") { await hold("cleanup"); mark("cleanup-returned"); }
      mark("cleanup-done");
    });
    pi.on("session_shutdown", () => { mark("second-cleanup"); });
    pi.on("agent_settled", async (_event, ctx) => {
      if (!scenario.startsWith("self-") || once) return;
      once = true; mark("settlement-start");
      if (scenario.endsWith("shutdown")) ctx.shutdown();
      try { await host.session[scenario.includes("sendUserMessage") ? "sendUserMessage" : "prompt"]("self-next"); selfResult = "accepted"; }
      catch (error) { selfResult = { code: error.code, message: error.message }; }
      mark("settlement-returned");
    });
    pi.on("agent_end", async event => {
      if (scenario !== "observer-alias") return;
      caught = event.messages.find(message => message.role === "assistant");
      mark("observer-held"); await hold("observer");
      caught.content[0].text = "late-observer-corruption";
      caught.content.push({ type: "text", text: "nested-late-corruption" });
      mark("observer-returned");
    });
  };
  const services = await createAgentSessionServices({ cwd, agentDir: join(dir, "agent"), modelRuntime, resourceLoaderOptions: { extensionFactories: [extensionFactory], noSkills: true, noPromptTemplates: true, noThemes: true } });
  return { ...await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: faux.getModel(), noTools: true }), services, diagnostics: services.diagnostics };
};
host = await createAgentSessionRuntime(factory, { cwd: dir, agentDir: join(dir, "agent"), sessionManager: SessionManager.create(dir, dir) });
await host.session.bindExtensions({ shutdownHandler: () => { requested = true; }, onError: error => errors.push(error) });
host.session.subscribe(event => {
  if (event.type !== "agent_settled") return;
  setImmediate(() => {
    if (!requested || !host.session.isIdle || host.session.isSettling) return;
    shutdownWork = host.dispose({ terminal: true }); void shutdownWork.catch(() => {});
  });
});
if (scenario === "cleanup-deadline") {
  const started = Date.now(); await host.dispose({ terminal: true, beforeShutdown: async () => mark("before-shutdown") });
  publish({ type: "disposed", disposed: host.session.isDisposed, elapsed: Date.now() - started, diagnostics: host.diagnostics, errors });
  mark("disposed");
  await hold("after-disposal");
  writeFileSync(join(dir, "release-cleanup"), "release");
  while (!existsSync(join(dir, "cleanup-returned"))) await new Promise(resolve => setTimeout(resolve, 10));
  await new Promise(resolve => setTimeout(resolve, 50));
  publish({ type: "late-cleanup-proof", secondStarted: existsSync(join(dir, "second-cleanup")), before: existsSync(join(dir, "before-shutdown")) });
} else if (scenario.startsWith("self-")) {
  const run = host.session.prompt("seed"); void run.catch(() => {});
  let timer; const completed = await Promise.race([run.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 500); })]); clearTimeout(timer);
  const idle = host.session.isIdle, admissions = host.session.inputAdmissionCount;
  let later;
  if (completed && !requested) { await host.session.prompt("unrelated-later-input"); later = host.session.messages; }
  else if (!completed) await host.session.abort();
  await run.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  if (shutdownWork) await shutdownWork;
  else await host.dispose({ terminal: true });
  publish({ type: "self-proof", completed, selfResult, idle, admissions, requested, later, disposed: host.session.isDisposed, cleanup: existsSync(join(dir, "cleanup-done")) });
} else if (scenario === "observer-alias") {
  const run = host.session.prompt("seed"); void run.catch(() => {});
  while (!existsSync(join(dir, "observer-held"))) await new Promise(resolve => setTimeout(resolve, 10));
  const manager = host.session.sessionManager;
  const snapshot = () => ({ history: manager.getEntries(), projection: manager.buildSessionProjection(), context: host.session.messages, revision: manager.revision(), jsonl: readFileSync(manager.getSessionFile(), "utf8") });
  const before = JSON.stringify(snapshot());
  await host.dispose({ terminal: true }); await run;
  const afterDisposal = JSON.stringify(snapshot());
  writeFileSync(join(dir, "release-observer"), "release");
  while (!existsSync(join(dir, "observer-returned"))) await new Promise(resolve => setTimeout(resolve, 10));
  await new Promise(resolve => setImmediate(resolve));
  publish({ type: "alias-proof", before: JSON.parse(before), afterDisposal: JSON.parse(afterDisposal), afterLateMutation: snapshot(), captured: caught, disposed: host.session.isDisposed });
}
faux.unregister(); process.exit(0);
`;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
});

async function launch(scenario: string) {
	const dir = mkdtempSync(join(tmpdir(), "pi-r2-runtime-"));
	mkdirSync(join(dir, "agent"));
	const path = join(dir, "runner.mjs");
	writeFileSync(path, runner);
	const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [path], {
		cwd: dir,
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: dir,
			TMPDIR: dir,
			PI_CODING_AGENT_DIR: join(dir, "agent"),
			PI_OFFLINE: "1",
			PI_NO_LOCAL_LLM: "1",
			PI_PACKAGE_DIR: resolve("."),
			PI_R2_DIR: dir,
			PI_R2_CASE: scenario,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
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
	const closed = new Promise<void>((done) => child.once("close", () => done()));
	cleanups.push(async () => {
		for (const gate of ["cleanup", "after-disposal", "observer"])
			writeFileSync(join(dir, `release-${gate}`), "release");
		child.stdin.end();
		const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
		await closed;
		clearTimeout(timer);
		if (evidence) {
			writeFileSync(join(evidence, `r2-${prefix}-${scenario}.jsonl`), stdout);
			writeFileSync(join(evidence, `r2-${prefix}-${scenario}.stderr.log`), stderr);
		}
		rmSync(dir, { recursive: true, force: true });
	});
	return {
		dir,
		release: (name: string) => writeFileSync(join(dir, `release-${name}`), "release"),
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
			await closed;
			return { code: child.exitCode, signal: child.signalCode };
		},
	};
}

describe.skipIf(!existsSync(join(built, "cli.js")))("PR117 security round2 native process regressions", () => {
	it("R2-S1: completed disposal expires dispatch before a held cleanup returns", async () => {
		const p = await launch("cleanup-deadline");
		const disposed = await p.wait("disposed");
		expect(disposed).toMatchObject({ disposed: true });
		expect(disposed.elapsed).toBeLessThan(2000);
		p.release("after-disposal");
		const proof = await p.wait("late-cleanup-proof");
		expect(proof).toMatchObject({ secondStarted: false, before: true });
		expect(disposed.diagnostics).toEqual(
			expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining("cleanup incomplete") })]),
		);
		expect(disposed.errors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					event: "session_shutdown",
					error: expect.stringContaining("cleanup incomplete"),
				}),
			]),
		);
		expect(await p.exit()).toEqual({ code: 0, signal: null });
	});

	it.each(["prompt", "sendUserMessage"] as const)(
		"R2-S2: awaiting own settlement %s refuses without self-join and later input works",
		async (entry) => {
			const p = await launch(`self-${entry}`);
			const proof = await p.wait("self-proof");
			expect(proof).toMatchObject({
				completed: true,
				idle: true,
				admissions: 0,
				selfResult: { code: "INPUT_ADMISSION_BUSY" },
				disposed: true,
				cleanup: true,
			});
			expect(JSON.stringify(proof.later)).toContain("unrelated-later-input");
			expect(JSON.stringify(proof.later)).not.toContain("self-next");
			expect(await p.exit()).toEqual({ code: 0, signal: null });
		},
	);

	it.each(["prompt", "sendUserMessage"] as const)(
		"R2-S2: awaiting own settlement %s releases admission for requested graceful shutdown",
		async (entry) => {
			const p = await launch(`self-${entry}-shutdown`);
			const proof = await p.wait("self-proof");
			expect(proof).toMatchObject({
				completed: true,
				idle: true,
				admissions: 0,
				requested: true,
				selfResult: { code: "INPUT_ADMISSION_BUSY" },
				disposed: true,
				cleanup: true,
			});
			expect(await p.exit()).toEqual({ code: 0, signal: null });
		},
	);

	it("R2-S5: cancelled agent_end payload cannot mutate history, projection, context, revision or JSONL", async () => {
		const p = await launch("observer-alias");
		const proof = await p.wait("alias-proof");
		expect(proof.disposed).toBe(true);
		expect(JSON.stringify(proof.captured)).toContain("late-observer-corruption");
		expect(proof.afterLateMutation).toEqual(proof.afterDisposal);
		expect(proof.afterDisposal).toEqual(proof.before);
		expect(JSON.stringify(proof.afterLateMutation)).not.toContain("late-observer-corruption");
		expect(await p.exit()).toEqual({ code: 0, signal: null });
	});
});
