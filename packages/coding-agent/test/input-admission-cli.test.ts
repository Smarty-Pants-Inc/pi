import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type RecordLine = Record<string, unknown>;
const cli = process.env.PI_ADMISSION_CLI ?? resolve("dist/bundle/cli.js");
const fixture = `import { createFauxCore, fauxAssistantMessage } from ${JSON.stringify(resolve("../ai/dist/providers/faux.js"))};
export default function(pi) {
  const faux = createFauxCore({ provider: "admission-faux" });
  faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage("offline answer")));
  const round4 = process.env.PI_ROUND4_CASE;
  const held = async (name, ctx) => { ctx.ui.notify(name + "-held"); await new Promise(resolve => setTimeout(resolve, 60000)); };
  pi.on("agent_start", async (_event, ctx) => { if (round4?.includes("fence-release")) await ctx.ui.confirm("run-release", "release run", { timeout: 10000 }); });
  for (const boundary of ["turn_end", "agent_before_settle"]) pi.on(boundary, async (_event, ctx) => { if (round4?.includes(boundary)) await held(boundary, ctx); });
  pi.on("user_bash", async (_event, ctx) => { if (round4?.includes("retired-bash")) { await ctx.ui.confirm("bash-held", "release bash", { timeout: 10000 }); if (round4.endsWith("true")) return { result: { output: "retired-handled-result", exitCode: 0, cancelled: false, truncated: false } }; } });
  pi.registerCommand("self-replace", { handler: async (_args, ctx) => { await ctx.newSession(); } });
  // Synthetic in-memory auth is never read from a credential store or sent over a network.
  pi.registerProvider(faux.provider, { baseUrl: faux.getModel().baseUrl, apiKey: "offline-faux-test-only", api: faux.api, streamSimple: faux.streamSimple, models: faux.models });
  pi.on("session_start", async (_event, ctx) => {
    const start = Number(process.env.PI_START_COUNT || 0) + 1; process.env.PI_START_COUNT = String(start);
    ctx.ui.notify("binding-" + start);
    if (process.env.PI_ADMISSION_BIND_ONCE && start === 2) await ctx.ui.confirm("receiving-held", "release receiving", { timeout: 10000 });
    if (process.env.PI_ADMISSION_BIND_ONCE && start === 3) await ctx.ui.confirm("duplicate-held", "duplicate receiving", { timeout: 10000 });
    if (process.env.PI_ADMISSION_NONCOOPERATIVE_START || (process.env.PI_ADMISSION_RECEIVING && start === 2)) { ctx.ui.notify("binding-nondialog-held"); await new Promise(resolve => setTimeout(resolve, 60000)); }
    if (process.env.PI_ADMISSION_STARTUP) await ctx.ui.confirm("startup-held", "release startup", { timeout: 10000 });
    if (process.env.PI_ADMISSION_STARTUP_CHAIN) await ctx.ui.confirm("startup-next", "next dialog", { timeout: 10000 });
    await pi.setModel(faux.getModel());
    if (round4 === "binding-shutdown") { ctx.shutdown(); ctx.ui.notify("binding-shutdown-requested"); }
  });
  pi.on("agent_settled", async (_event, ctx) => {
    if (process.env.PI_ADMISSION_SETTLEMENT || round4?.includes("fence-release")) { ctx.ui.notify("settlement-nondialog-held"); await new Promise((resolve) => setTimeout(resolve, 60000)); }
  });
  let holdSwitch = false, holdShutdown = false;
  pi.registerCommand("hold-switch", { handler: async () => { holdSwitch = true; } });
  pi.registerCommand("nondialog-command", { handler: async (_args, ctx) => { ctx.ui.notify("command-nondialog-held"); await new Promise(resolve => setTimeout(resolve, 60000)); } });
  pi.registerCommand("hold-shutdown", { handler: async () => { holdShutdown = true; } });
  pi.registerCommand("quit-test", { handler: async (_args, ctx) => { ctx.shutdown(); } });
  pi.on("input", async (event, ctx) => {
    if (event.text === "" || event.text === "image-only-transform") return { action: "transform", text: "", images: event.images };
    if (event.text.startsWith("print:")) {
      console.error(JSON.stringify({ proof: "print-input", admission: pi.hostCapabilities.inputAdmission, idle: ctx.isIdle(), pending: ctx.isPromptPending() }));
      return { action: "handled" };
    }
    if (event.text.startsWith("nondialog:")) { ctx.ui.notify("input-nondialog-held"); await new Promise((resolve) => setTimeout(resolve, 60000)); }
    if (event.text.startsWith("hold:")) await ctx.ui.confirm("input-held", event.text, { timeout: 10000 });
    if (event.text.includes("handled")) return { action: "handled" };
    return { action: "transform", text: "transformed:" + event.text, images: event.images };
  });
  pi.on("session_before_switch", async (_event, ctx) => {
    if (round4?.includes("fence-release")) { await ctx.ui.confirm("switch-release", "release switch", { timeout: 10000 }); return { cancel: !round4.includes("failed") }; }
    if (holdSwitch && process.env.PI_ADMISSION_NONCOOPERATIVE_SWITCH) { ctx.ui.notify("switch-nondialog-held"); await new Promise(resolve => setTimeout(resolve, 60000)); }
    else if (holdSwitch) await ctx.ui.confirm("switch-held", "release switch", { timeout: 10000 });
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    if (holdShutdown) await ctx.ui.confirm("shutdown-held", "release shutdown", { timeout: 10000 });
  });
}`;

interface ChildProof {
	child: ChildProcessWithoutNullStreams;
	records: RecordLine[];
	send(command: RecordLine): void;
	response(id: string): Promise<RecordLine>;
	dialog(title: string): Promise<RecordLine>;
	marker(message: string): Promise<RecordLine>;
	release(request: RecordLine): void;
	exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	target: string;
	stderr(): string;
}

// smarty-dev#3048: exercise the built package's actual bin entry, not source mocks or paid APIs.
describe.skipIf(!existsSync(cli))("installed-style offline input admission", () => {
	const cleanups: Array<() => Promise<void>> = [];
	let sequence = 0;
	afterEach(async () => {
		while (cleanups.length) await cleanups.pop()?.();
	});

	async function launch(label: string, mode: "rpc" | "print" = "rpc"): Promise<ChildProof> {
		const temp = mkdtempSync(join(tmpdir(), "pi-admission-cli-"));
		const extension = join(temp, "admission.mjs");
		const agentDir = join(temp, "agent");
		mkdirSync(agentDir);
		writeFileSync(extension, fixture);
		const target = join(temp, "target.jsonl");
		writeFileSync(
			target,
			`${JSON.stringify({ type: "session", version: 3, id: "target", timestamp: new Date().toISOString(), cwd: temp })}\n`,
		);
		const args = [
			cli,
			"--offline",
			"--no-session",
			"--no-tools",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"-e",
			extension,
		];
		args.push(...(mode === "rpc" ? ["--mode", "rpc"] : ["--print", "print:handled"]));
		const child = spawn(process.execPath, args, {
			cwd: temp,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				PATH: process.env.PATH,
				HOME: temp,
				USERPROFILE: temp,
				TMPDIR: temp,
				PI_CODING_AGENT_DIR: agentDir,
				PI_OFFLINE: "1",
				PI_PACKAGE_DIR: resolve("."),
				PI_ROUND4_CASE: label,
				PI_ADMISSION_STARTUP: label.includes("startup") ? "1" : "",
				PI_ADMISSION_BIND_ONCE: label === "single-rebind" ? "1" : "",
				PI_ADMISSION_NONCOOPERATIVE_START: label.includes("noncooperative-start") ? "1" : "",
				PI_ADMISSION_NONCOOPERATIVE_SWITCH: label.includes("noncooperative-switch") ? "1" : "",
				PI_ADMISSION_RECEIVING: label.includes("noncooperative-receiving") ? "1" : "",
				PI_ADMISSION_STARTUP_CHAIN: label === "startup-signal-refusal" ? "1" : "",
				PI_ADMISSION_SETTLEMENT: label.includes("settlement") ? "1" : "",
				PI_NO_LOCAL_LLM: "1",
				AWS_EC2_METADATA_DISABLED: "true",
			},
		});
		const records: RecordLine[] = [];
		let stdout = "",
			stderr = "",
			framed = "";
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
		if (mode === "print") child.stdin.end();
		const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, failed) => {
			child.once("error", failed);
			child.once("close", (code, signal) => done({ code, signal }));
		});
		const proofName = `${process.env.PI_PROOF_PREFIX ?? "green"}-${++sequence}-${label}`;
		cleanups.push(async () => {
			child.stdin.end();
			const timeout = setTimeout(() => {
				child.kill("SIGKILL");
			}, 3000);
			try {
				const result = await exited;
				if (process.env.TASK_OUT) {
					writeFileSync(join(process.env.TASK_OUT, `cli-${proofName}.jsonl`), stdout);
					writeFileSync(join(process.env.TASK_OUT, `cli-${proofName}.stderr.log`), stderr);
					writeFileSync(join(process.env.TASK_OUT, `cli-${proofName}.exit.json`), JSON.stringify(result));
				}
			} finally {
				clearTimeout(timeout);
				rmSync(temp, { recursive: true, force: true });
			}
		});
		const send = (command: RecordLine) => {
			child.stdin.write(`${JSON.stringify(command)}\n`);
		};
		const wait = async (predicate: (record: RecordLine) => boolean) => {
			await vi.waitFor(
				() => {
					expect(records.some(predicate), stderr).toBe(true);
				},
				{ timeout: 15000 },
			);
			return records.find(predicate)!;
		};
		return {
			child,
			records,
			send,
			response: (id) => wait((record) => record.type === "response" && record.id === id),
			dialog: (title) => wait((record) => record.type === "extension_ui_request" && record.title === title),
			marker: (message) => wait((record) => record.type === "extension_ui_request" && record.message === message),
			release: (request) => send({ type: "extension_ui_response", id: request.id, confirmed: true }),
			exited,
			target,
			stderr: () => stderr,
		};
	}

	it.each([
		["steer", "new_session"],
		["follow_up", "new_session"],
		["steer", "switch_session"],
		["follow_up", "switch_session"],
	] as const)("%s cannot disappear across %s while an earlier hook awaits", async (inputType, replacementType) => {
		const p = await launch(`${inputType}-${replacementType}`);
		p.send({ id: "held", type: inputType, message: "hold:must-survive" });
		const dialog = await p.dialog("input-held");
		p.send({ id: "state-held", type: "get_state" });
		expect((await p.response("state-held")).data).toMatchObject({
			capabilities: { inputAdmission: 1 },
			inputAdmissionCount: 1,
			pendingMessageCount: 1,
			isIdle: false,
			isPromptPending: true,
		});
		p.send({ id: "replace-busy", type: replacementType, sessionPath: p.target });
		expect(await p.response("replace-busy")).toMatchObject({
			success: false,
			error: expect.stringContaining("INPUT_ADMISSION_BUSY"),
		});
		expect(p.records.filter((record) => record.type === "response" && record.id === "held")).toEqual([]);
		p.release(dialog);
		expect(await p.response("held")).toMatchObject({ success: true });
		p.send({ id: "still-busy", type: replacementType, sessionPath: p.target });
		expect(await p.response("still-busy")).toMatchObject({
			success: false,
			error: expect.stringContaining("INPUT_ADMISSION_BUSY"),
		});
		p.send({ id: "recover", type: "clear_queue" });
		expect((await p.response("recover")).data).toEqual(
			inputType === "steer"
				? { steering: ["transformed:hold:must-survive"], followUp: [] }
				: { steering: [], followUp: ["transformed:hold:must-survive"] },
		);
		p.send({ id: "replace-safe", type: replacementType, sessionPath: p.target });
		expect(await p.response("replace-safe")).toMatchObject({ success: true, data: { cancelled: false } });
	});

	it("a late success receipt cannot belong to a disposed outgoing session", async () => {
		const p = await launch("late-ack-reproduction");
		p.send({ id: "original", type: "get_state" });
		const original = (await p.response("original")).data as RecordLine;
		p.send({ id: "held", type: "follow_up", message: "hold:late-ack" });
		const dialog = await p.dialog("input-held");
		p.send({ id: "new", type: "new_session" });
		const replacement = await p.response("new");
		p.release(dialog);
		const inputReceipt = await p.response("held");
		p.send({ id: "after", type: "get_state" });
		const after = (await p.response("after")).data as RecordLine;
		// On 2ba9a3ce2: replacement succeeds, then input succeeds, but the new queue is empty.
		expect(replacement).toMatchObject({ success: false, error: expect.stringContaining("INPUT_ADMISSION_BUSY") });
		expect(inputReceipt).toMatchObject({ success: true });
		expect(after).toMatchObject({ sessionId: original.sessionId, pendingMessageCount: 1 });
	});

	it("handled prompt is accounted before the hook and acknowledged only after handling", async () => {
		const p = await launch("handled-prompt");
		p.send({ id: "held", type: "prompt", message: "hold:handled" });
		const dialog = await p.dialog("input-held");
		p.send({ id: "new", type: "new_session" });
		expect(await p.response("new")).toMatchObject({
			success: false,
			error: expect.stringContaining("INPUT_ADMISSION_BUSY"),
		});
		p.release(dialog);
		expect(await p.response("held")).toMatchObject({ success: true });
		p.send({ id: "new-safe", type: "new_session" });
		expect(await p.response("new-safe")).toMatchObject({ success: true });
		expect(p.records.filter((record) => record.id === "held" && record.type === "response")).toHaveLength(1);
	});

	it("rejects arrivals during async before-switch rather than acknowledging the outgoing session", async () => {
		const p = await launch("switch-fence");
		p.send({ id: "arm", type: "prompt", message: "/hold-switch" });
		await p.response("arm");
		p.send({ id: "new", type: "new_session" });
		const dialog = await p.dialog("switch-held");
		for (const type of ["prompt", "steer", "follow_up"]) {
			p.send({ id: type, type, message: "handled:late" });
			expect(await p.response(type)).toMatchObject({
				success: false,
				error: expect.stringContaining("INPUT_ADMISSION_FENCED"),
			});
		}
		p.release(dialog);
		expect(await p.response("new")).toMatchObject({ success: true });
	});

	it("rejects arrivals during async shutdown/dispose and emits no success for them", async () => {
		const p = await launch("shutdown-fence");
		p.send({ id: "arm", type: "prompt", message: "/hold-shutdown" });
		await p.response("arm");
		p.send({ id: "quit", type: "prompt", message: "/quit-test" });
		const dialog = await p.dialog("shutdown-held");
		for (const type of ["prompt", "steer", "follow_up"]) {
			p.send({ id: type, type, message: "handled:late" });
			expect(await p.response(type)).toMatchObject({
				success: false,
				error: expect.stringContaining("INPUT_ADMISSION_FENCED"),
			});
		}
		p.release(dialog);
		expect(await p.exited).toEqual({ code: 0, signal: null });
	});

	it("SIGTERM aborts admitted input with one authoritative failure, never a late success", async () => {
		const p = await launch("signal-abort");
		p.send({ id: "held", type: "follow_up", message: "hold:must-reject" });
		await p.dialog("input-held");
		p.child.kill("SIGTERM");
		expect(await p.exited).toEqual({ code: 143, signal: null });
		expect(p.records.filter((record) => record.id === "held" && record.type === "response")).toEqual([
			expect.objectContaining({ success: false, error: expect.stringContaining("INPUT_ADMISSION_ABORTED") }),
		]);
	});

	it("EOF returns an attachment-preserving receipt for already acknowledged undelivered input", async () => {
		const p = await launch("eof-receipt");
		const image = { type: "image", mimeType: "image/png", data: "attachment" };
		p.send({ id: "queued", type: "steer", message: "queue-with-image", images: [image] });
		expect(await p.response("queued")).toMatchObject({ success: true });
		for (const [id, type] of [
			["queued-2", "steer"],
			["queued-3", "follow_up"],
			["queued-4", "follow_up"],
		] as const) {
			p.send({ id, type, message: id, images: [image] });
			expect(await p.response(id!)).toMatchObject({ success: true });
		}
		p.child.stdin.end();
		expect(await p.exited).toEqual({ code: 0, signal: null });
		expect(p.records.filter((record) => record.type === "input_rejected")).toEqual([
			expect.objectContaining({
				reason: "shutdown",
				messages: [
					expect.objectContaining({
						role: "user",
						content: [{ type: "text", text: "transformed:queue-with-image" }, image],
					}),
					...["queued-2", "queued-3", "queued-4"].map((id) =>
						expect.objectContaining({
							role: "user",
							content: [{ type: "text", text: `transformed:${id}` }, image],
						}),
					),
				],
			}),
		]);
	});

	// smarty-dev#3048, PR #110 F1: EOF must close admission before joining command work.
	it.each(["live", "startup"] as const)("EOF aborts non-dialog input during %s draining", async (phase) => {
		const p = await launch(`eof-nondialog-${phase}`);
		const image = { type: "image", data: "eof-attachment", mimeType: "image/png" };
		const queue = () =>
			p.send({ id: "earlier-queue", type: "steer", message: "earlier-undelivered", images: [image] });
		if (phase === "startup") {
			const dialog = await p.dialog("startup-held");
			queue();
			p.send({ id: "held", type: "follow_up", message: "nondialog:held" });
			p.release(dialog);
		} else {
			queue();
			expect(await p.response("earlier-queue")).toMatchObject({ success: true });
			p.send({ id: "held", type: "steer", message: "nondialog:held" });
		}
		await p.marker("input-nondialog-held");
		expect(await p.response("earlier-queue")).toMatchObject({ success: true });
		p.child.stdin.end();
		expect(
			await Promise.race([p.exited, new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 1500))]),
		).toEqual({ code: 0, signal: null });
		expect(p.records.filter((record) => record.id === "held" && record.type === "response")).toEqual([
			expect.objectContaining({ success: false, error: expect.stringContaining("INPUT_ADMISSION_ABORTED") }),
		]);
		expect(p.records.filter((record) => record.type === "input_rejected")).toEqual([
			expect.objectContaining({
				messages: [
					expect.objectContaining({ content: [{ type: "text", text: "transformed:earlier-undelivered" }, image] }),
				],
			}),
		]);
	});

	// smarty-dev#3048, PR #110 F5: mode-owned startup backlog needs correlated refusals.
	it("SIGTERM refuses startup commands exactly once before flush and exit", async () => {
		const p = await launch("startup-signal-refusal");
		await p.dialog("startup-held");
		p.send({ id: "startup-held-input", type: "follow_up", message: "handled:startup" });
		await new Promise((resolve) => setTimeout(resolve, 100));
		p.child.kill("SIGTERM");
		expect(await p.exited).toEqual({ code: 143, signal: null });
		expect(p.records.filter((record) => record.id === "startup-held-input" && record.type === "response")).toEqual([
			expect.objectContaining({ success: false, error: expect.stringContaining("INPUT_ADMISSION_SHUTDOWN") }),
		]);
	});

	// smarty-dev#3048, PR #110 F2/S1: never rely on a kill to escape settlement.
	it.each(["EOF", "SIGTERM", "SIGHUP"] as const)(
		"%s cancels a non-dialog settlement and flushes attachment receipts",
		async (ending) => {
			const p = await launch(`settlement-${ending}`);
			p.send({ id: "run", type: "prompt", message: "start" });
			await p.marker("settlement-nondialog-held");
			const image = { type: "image", data: "attachment", mimeType: "image/png" };
			p.send({ id: "queue", type: "steer", message: "undelivered", images: [image] });
			expect(await p.response("queue")).toMatchObject({ success: true });
			if (ending === "EOF") p.child.stdin.end();
			else p.child.kill(ending);
			expect(await p.exited).toEqual({
				code: ending === "EOF" ? 0 : ending === "SIGTERM" ? 143 : 129,
				signal: null,
			});
			expect(p.records.filter((record) => record.type === "input_rejected")).toEqual([
				expect.objectContaining({
					messages: [
						expect.objectContaining({ content: [{ type: "text", text: "transformed:undelivered" }, image] }),
					],
				}),
			]);
		},
	);

	// smarty-dev#3048, PR #110 R2-1: a refusal must not swap the settlement cancellation owner.
	it.each(["EOF", "SIGTERM", "SIGHUP"] as const)(
		"%s after BUSY replacement cancels held settlement",
		async (ending) => {
			const p = await launch(`busy-settlement-${ending}`);
			p.send({ id: "run", type: "prompt", message: "start" });
			await p.marker("settlement-nondialog-held");
			p.send({ id: "refused", type: "new_session" });
			expect(await p.response("refused")).toMatchObject({
				success: false,
				error: expect.stringContaining("INPUT_ADMISSION_BUSY"),
			});
			const image = { type: "image", data: "attachment", mimeType: "image/png" };
			p.send({ id: "queue", type: "follow_up", message: "undelivered", images: [image] });
			await p.response("queue");
			if (ending === "EOF") p.child.stdin.end();
			else p.child.kill(ending);
			expect(
				await Promise.race([p.exited, new Promise((resolve) => setTimeout(() => resolve("hung"), 1800))]),
			).toEqual({ code: ending === "EOF" ? 0 : ending === "SIGTERM" ? 143 : 129, signal: null });
			expect(p.records.filter((record) => record.type === "input_rejected")).toEqual([
				expect.objectContaining({
					messages: [
						expect.objectContaining({ content: [{ type: "text", text: "transformed:undelivered" }, image] }),
					],
				}),
			]);
		},
	);

	// smarty-dev#3048, PR #110 R2-2/S6: real commands initialize one receiving event owner.
	it("RPC receiving initialization occurs once and remains fenced until ready", async () => {
		const p = await launch("single-rebind");
		await p.marker("binding-1");
		p.send({ id: "new", type: "new_session" });
		const held = await p.dialog("receiving-held");
		p.send({ id: "early", type: "prompt", message: "handled:early" });
		expect(await p.response("early")).toMatchObject({
			success: false,
			error: expect.stringContaining("INPUT_ADMISSION_FENCED"),
		});
		p.release(held);
		expect(
			await Promise.race([p.response("new"), new Promise((resolve) => setTimeout(() => resolve("hung"), 1500))]),
		).toMatchObject({ success: true });
		expect(p.records.filter((record) => record.message === "binding-3")).toEqual([]);
		p.send({ id: "run", type: "prompt", message: "ready" });
		await p.response("run");
		await vi.waitFor(() => expect(p.records.filter((record) => record.type === "agent_settled")).toHaveLength(1));
		for (const role of ["user", "assistant"]) {
			expect(
				p.records.filter(
					(record) =>
						record.type === "message_end" &&
						typeof record.message === "object" &&
						record.message !== null &&
						"role" in record.message &&
						record.message.role === role,
				),
			).toHaveLength(1);
		}
	});

	// smarty-dev#3048, PR #110 S1/S4: terminal cancellation precedes joining owned operations.
	it.each(["EOF", "SIGTERM", "SIGHUP"] as const)(
		"%s cancels noncooperative startup and refuses correlated backlog",
		async (ending) => {
			const p = await launch(`noncooperative-start-${ending}`);
			await p.marker("binding-nondialog-held");
			p.send({ id: "queued", type: "steer", message: "unaccepted" });
			await new Promise((resolve) => setTimeout(resolve, 50));
			if (ending === "EOF") p.child.stdin.end();
			else p.child.kill(ending);
			expect(
				await Promise.race([p.exited, new Promise((resolve) => setTimeout(() => resolve("hung"), 1800))]),
			).toEqual({ code: ending === "EOF" ? 0 : ending === "SIGTERM" ? 143 : 129, signal: null });
			expect(p.records.filter((record) => record.id === "queued")).toEqual([
				expect.objectContaining({ success: false, error: expect.stringContaining("INPUT_ADMISSION_SHUTDOWN") }),
			]);
		},
	);
	it.each(["EOF", "SIGTERM", "SIGHUP"] as const)(
		"%s cancels a dispatched non-dialog command with one failure response",
		async (ending) => {
			const p = await launch(`noncooperative-command-${ending}`);
			p.send({ id: "held-command", type: "prompt", message: "/nondialog-command" });
			await p.marker("command-nondialog-held");
			if (ending === "EOF") p.child.stdin.end();
			else p.child.kill(ending);
			expect(
				await Promise.race([p.exited, new Promise((resolve) => setTimeout(() => resolve("hung"), 1800))]),
			).toEqual({ code: ending === "EOF" ? 0 : ending === "SIGTERM" ? 143 : 129, signal: null });
			expect(p.records.filter((record) => record.id === "held-command")).toEqual([
				expect.objectContaining({ success: false, error: expect.stringContaining("INPUT_ADMISSION_SHUTDOWN") }),
			]);
		},
	);
	it("EOF aborts active bash before joining its correlated result", async () => {
		const p = await launch("active-bash");
		p.send({ id: "bash", type: "bash", command: "echo owned-bash-started; sleep 3; echo must-not-run" });
		await vi.waitFor(() =>
			expect(
				p.records.some(
					(record) =>
						record.type === "bash_execution_update" && String(record.delta).includes("owned-bash-started"),
				),
			).toBe(true),
		);
		p.child.stdin.end();
		expect(await Promise.race([p.exited, new Promise((resolve) => setTimeout(() => resolve("hung"), 1800))])).toEqual(
			{ code: 0, signal: null },
		);
		expect(p.records.filter((record) => record.id === "bash" && record.type === "response")).toEqual([
			expect.objectContaining({ success: true, data: expect.objectContaining({ cancelled: true }) }),
		]);
		expect(p.records.some((record) => String(record.delta).includes("must-not-run"))).toBe(false);
	});
	it.each([
		["EOF", "switch"],
		["EOF", "receiving"],
		["SIGTERM", "switch"],
		["SIGTERM", "receiving"],
		["SIGHUP", "switch"],
		["SIGHUP", "receiving"],
	] as const)("%s cancels held non-dialog %s lifecycle with a correlated disposition", async (ending, phase) => {
		const p = await launch(`noncooperative-${phase}-${ending}`);
		if (phase === "switch") {
			p.send({ id: "arm", type: "prompt", message: "/hold-switch" });
			await p.response("arm");
		}
		p.send({ id: "replace", type: "new_session" });
		await p.marker(phase === "switch" ? "switch-nondialog-held" : "binding-nondialog-held");
		if (ending === "EOF") p.child.stdin.end();
		else p.child.kill(ending);
		expect(await Promise.race([p.exited, new Promise((resolve) => setTimeout(() => resolve("hung"), 1800))])).toEqual(
			{ code: ending === "EOF" ? 0 : ending === "SIGTERM" ? 143 : 129, signal: null },
		);
		expect(p.records.filter((record) => record.id === "replace")).toEqual([
			expect.objectContaining({ success: false, error: expect.stringContaining("INPUT_ADMISSION_SHUTDOWN") }),
		]);
		expect(p.records.some((record) => record.fatal)).toBe(false);
	});
	// smarty-dev#3048, PR #110 S5: malformed envelopes cannot poison the startup refusal loop.
	it("valid and malformed startup records preserve shutdown accounting", async () => {
		const p = await launch("startup-malformed");
		await p.dialog("startup-held");
		p.child.stdin.write('null\n[]\n{"type":17}\n{"id":17,"type":"steer"}\n');
		p.send({ id: "valid", type: "follow_up", message: "unaccepted" });
		await new Promise((resolve) => setTimeout(resolve, 100));
		p.child.kill("SIGTERM");
		expect(await Promise.race([p.exited, new Promise((resolve) => setTimeout(() => resolve("hung"), 1800))])).toEqual(
			{ code: 143, signal: null },
		);
		expect(p.records.filter((record) => record.command === "parse" && record.success === false)).toHaveLength(4);
		expect(p.records.filter((record) => record.id === "valid")).toEqual([
			expect.objectContaining({ success: false, error: expect.stringContaining("INPUT_ADMISSION_SHUTDOWN") }),
		]);
	});
	// smarty-dev#3048 / PR #110 R3-1 (security R3-S3): terminal ownership spans replacement.
	it.each(["EOF", "SIGTERM", "SIGHUP"] as const)(
		"round4 %s cancels a retired dispatched command exactly once",
		async (ending) => {
			const p = await launch(`retired-command-${ending}`);
			p.send({ id: "held-command", type: "prompt", message: "/nondialog-command" });
			await p.marker("command-nondialog-held");
			p.send({ id: "replace", type: "new_session" });
			expect(await p.response("replace")).toMatchObject({ success: true, data: { cancelled: false } });
			if (ending === "EOF") p.child.stdin.end();
			else p.child.kill(ending);
			expect(
				await Promise.race([p.exited, new Promise((resolve) => setTimeout(() => resolve("hung"), 1800))]),
			).toEqual({ code: ending === "EOF" ? 0 : ending === "SIGTERM" ? 143 : 129, signal: null });
			expect(p.records.filter((record) => record.id === "held-command")).toEqual([
				expect.objectContaining({ success: false, error: expect.stringContaining("INPUT_ADMISSION_SHUTDOWN") }),
			]);
		},
	);
	it("round4 a command can still replace its own session", async () => {
		const p = await launch("self-replace");
		p.send({ id: "self", type: "prompt", message: "/self-replace" });
		expect(await p.response("self")).toMatchObject({ success: true });
	});
	// smarty-dev#3048 / PR #110 R3-2 (security R3-S2): both native boundaries must cancel.
	it.each([
		["turn_end", "EOF"],
		["turn_end", "SIGTERM"],
		["turn_end", "SIGHUP"],
		["agent_before_settle", "EOF"],
		["agent_before_settle", "SIGTERM"],
		["agent_before_settle", "SIGHUP"],
	] as const)(
		"round4 terminal cancellation releases %s under %s and returns original queued attachments",
		async (boundary, ending) => {
			const p = await launch(`${boundary}-${ending}`);
			p.send({ id: "run", type: "prompt", message: "run" });
			expect(await p.response("run")).toMatchObject({ success: true });
			await p.marker(`${boundary}-held`);
			const image = { type: "image", mimeType: "image/png", data: "original-queued-bytes" };
			p.send({ id: "queued", type: "follow_up", message: "boundary-queue", images: [image] });
			expect(await p.response("queued")).toMatchObject({ success: true });
			if (ending === "EOF") p.child.stdin.end();
			else p.child.kill(ending);
			expect(
				await Promise.race([p.exited, new Promise((resolve) => setTimeout(() => resolve("hung"), 1800))]),
			).toEqual({ code: ending === "EOF" ? 0 : ending === "SIGTERM" ? 143 : 129, signal: null });
			expect(p.records.filter((record) => record.type === "input_rejected")).toEqual([
				expect.objectContaining({
					messages: [
						expect.objectContaining({
							content: [{ type: "text", text: "transformed:boundary-queue" }, image],
						}),
					],
				}),
			]);
		},
	);
	// smarty-dev#3048 / PR #110 R3-9 (security R3-S1): successful acquisition cannot orphan settlement.
	it.each([
		["cancelled", "EOF"],
		["cancelled", "SIGTERM"],
		["cancelled", "SIGHUP"],
		["failed", "EOF"],
		["failed", "SIGTERM"],
		["failed", "SIGHUP"],
	] as const)(
		"round4 %s replacement preserves overlapping settlement cancellation under %s",
		async (result, ending) => {
			const p = await launch(`fence-release-${result}-${ending}`);
			p.send({ id: "run", type: "prompt", message: "run" });
			const runGate = await p.dialog("run-release");
			p.send({ id: "replace", type: "new_session" });
			const switchGate = await p.dialog("switch-release");
			p.release(runGate);
			await p.marker("settlement-nondialog-held");
			p.release(switchGate);
			expect(await p.response("replace")).toMatchObject(
				result === "cancelled"
					? { success: true, data: { cancelled: true } }
					: { success: false, error: expect.stringContaining("INPUT_ADMISSION_BUSY") },
			);
			if (ending === "EOF") p.child.stdin.end();
			else p.child.kill(ending);
			expect(
				await Promise.race([p.exited, new Promise((resolve) => setTimeout(() => resolve("hung"), 1800))]),
			).toEqual({ code: ending === "EOF" ? 0 : ending === "SIGTERM" ? 143 : 129, signal: null });
		},
	);
	// smarty-dev#3048 / PR #110 R3-3 (security R3-S5): overflow itself initiates terminal cancellation.
	it("round4 startup overflow cancels a non-dialog binding before EOF", async () => {
		const p = await launch("noncooperative-start-overflow");
		await p.marker("binding-nondialog-held");
		for (let index = 0; index < 257; index++) p.send({ id: `backlog-${index}`, type: "get_state" });
		p.child.stdin.end();
		expect(await Promise.race([p.exited, new Promise((resolve) => setTimeout(() => resolve("hung"), 1800))])).toEqual(
			{ code: 1, signal: null },
		);
		expect(p.records.filter((record) => record.fatal)).toEqual([
			expect.objectContaining({ error: "RPC startup command queue limit exceeded" }),
		]);
		for (let index = 0; index < 256; index++)
			expect(p.records.filter((record) => record.id === `backlog-${index}`)).toEqual([
				expect.objectContaining({ success: false, error: expect.stringContaining("INPUT_ADMISSION_SHUTDOWN") }),
			]);
	});
	// smarty-dev#3048 / PR #110 R3-10 (security R3-S4): no executable or handled result under retired custody.
	it.each([false, true])("round4 held bash hook is refused after replacement (handled: %s)", async (handled) => {
		const p = await launch(`retired-bash-${handled}`);
		const sentinel = resolve(p.target, "..", "bash-started");
		p.send({ id: "bash", type: "bash", command: `echo retired-bash-started > ${JSON.stringify(sentinel)}` });
		const gate = await p.dialog("bash-held");
		p.send({ id: "replace", type: "new_session" });
		expect(await p.response("replace")).toMatchObject({ success: true, data: { cancelled: false } });
		p.release(gate);
		expect(await p.response("bash")).toMatchObject({
			success: false,
			error: expect.stringContaining("INPUT_ADMISSION_DISPOSED"),
		});
		expect(p.records.some((record) => record.type === "bash_execution_update")).toBe(false);
		expect(existsSync(sentinel)).toBe(false);
		p.send({ id: "messages", type: "get_messages" });
		expect((await p.response("messages")).data).toEqual({ messages: [] });
	});
	// smarty-dev#3048 / PR #110 R3-8: delivery of empty-text attachments clears native bookkeeping.
	it.each([
		["steer", ""],
		["follow_up", ""],
		["steer", "image-only-transform"],
		["follow_up", "image-only-transform"],
	] as const)("round4 consumed image-only %s from %s permits replacement and clean EOF", async (type, message) => {
		const p = await launch(`image-only-${type}`);
		p.send({
			id: "image",
			type,
			message,
			images: [{ type: "image", mimeType: "image/png", data: "original-queued-bytes" }],
		});
		expect(await p.response("image")).toMatchObject({ success: true });
		p.send({ id: "run", type: "prompt", message: "run" });
		await vi.waitFor(() => expect(p.records.some((record) => record.type === "agent_settled")).toBe(true));
		p.send({ id: "state", type: "get_state" });
		expect((await p.response("state")).data).toMatchObject({ pendingMessageCount: 0 });
		p.send({ id: "replace", type: "new_session" });
		expect(await p.response("replace")).toMatchObject({ success: true, data: { cancelled: false } });
		p.child.stdin.end();
		expect(await p.exited).toEqual({ code: 0, signal: null });
	});
	// smarty-dev#3048 / PR #110 R3-7: initial binding shutdown needs no incoming command.
	it("round4 binding-requested shutdown exits with stdin still open", async () => {
		const p = await launch("binding-shutdown");
		await p.marker("binding-shutdown-requested");
		expect(await Promise.race([p.exited, new Promise((resolve) => setTimeout(() => resolve("hung"), 1800))])).toEqual(
			{ code: 0, signal: null },
		);
	});

	it("print mode uses the same native admission contract before handled short-circuit", async () => {
		const p = await launch("print", "print");
		expect(await p.exited).toEqual({ code: 0, signal: null });
		expect(
			p
				.stderr()
				.split("\n")
				.filter((line) => line.includes("print-input"))
				.map((line) => JSON.parse(line)),
		).toEqual([{ proof: "print-input", admission: 1, idle: false, pending: true }]);
	});
});
