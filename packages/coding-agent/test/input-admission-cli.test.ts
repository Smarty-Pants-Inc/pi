import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type RecordLine = Record<string, unknown>;
const cli = process.env.PI_ADMISSION_CLI ?? resolve("dist/bundle/cli.js");
const fixture = `export default function(pi) {
  let holdSwitch = false, holdShutdown = false;
  pi.registerCommand("hold-switch", { handler: async () => { holdSwitch = true; } });
  pi.registerCommand("hold-shutdown", { handler: async () => { holdShutdown = true; } });
  pi.registerCommand("quit-test", { handler: async (_args, ctx) => { ctx.shutdown(); } });
  pi.on("input", async (event, ctx) => {
    if (event.text.startsWith("print:")) {
      console.error(JSON.stringify({ proof: "print-input", admission: pi.hostCapabilities.inputAdmission, idle: ctx.isIdle(), pending: ctx.isPromptPending() }));
      return { action: "handled" };
    }
    if (event.text.startsWith("hold:")) await ctx.ui.confirm("input-held", event.text, { timeout: 10000 });
    if (event.text.includes("handled")) return { action: "handled" };
    return { action: "transform", text: "transformed:" + event.text, images: event.images };
  });
  pi.on("session_before_switch", async (_event, ctx) => {
    if (holdSwitch) await ctx.ui.confirm("switch-held", "release switch", { timeout: 10000 });
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
		const proofName = `${++sequence}-${label}`;
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
