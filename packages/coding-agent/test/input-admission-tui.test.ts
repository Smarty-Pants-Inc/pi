import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const cli = process.env.PI_ADMISSION_CLI ?? resolve("dist/bundle/cli.js");
const fauxPath = resolve("../ai/dist/providers/faux.js");
const socket = join(tmpdir(), `pi-admission-${process.pid}.socket`);
const evidence = process.env.TASK_OUT;
const prefix = process.env.PI_PROOF_PREFIX ?? "green";
const tmuxAvailable = (() => {
	try {
		execFileSync("tmux", ["-V"]);
		return true;
	} catch {
		return false;
	}
})();

const fixture = `import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFauxCore, fauxAssistantMessage } from ${JSON.stringify(fauxPath)};
export default function(pi) {
  const dir = process.env.PI_PROOF_DIR;
  const mark = (name) => writeFileSync(join(dir, name), "ready");
  const hold = (name) => new Promise((resolve) => {
    const timer = setInterval(() => { if (existsSync(join(dir, "release-" + name))) { clearInterval(timer); resolve(); } }, 20);
  });
  const faux = createFauxCore({ provider: "tui-admission-faux" });
  faux.setResponses(process.env.PI_PROOF_CASE === "r4-images-retry" ? [fauxAssistantMessage("offline seed answer with enough content to compact"), fauxAssistantMessage("", { stopReason: "error", errorMessage: "context length exceeded" }), fauxAssistantMessage("offline retry answer")] : Array.from({ length: 8 }, () => fauxAssistantMessage("offline terminal answer")));
  // Synthetic in-memory auth is never read from a credential store or sent over a network.
  pi.registerProvider(faux.provider, { baseUrl: faux.getModel().baseUrl, apiKey: "offline-faux-test-only", api: faux.api, streamSimple: faux.streamSimple, models: faux.models });
  pi.on("session_start", async (_event, ctx) => {
    const count = Number(process.env.PI_START_COUNT || 0) + 1; process.env.PI_START_COUNT = String(count); mark("start-" + count);
    if (count === 2 && process.env.PI_PROOF_CASE === "replacement-shutdown") { mark("replacement-shutdown"); ctx.shutdown(); }
    await pi.setModel(faux.getModel());
    ctx.ui.setStatus("proof", "OFFLINE_PROOF_READY"); mark("ready");
  });
  let round4RunHeld = false, savedImages = [];
  pi.registerShortcut("ctrl+shift+c", { handler: ctx => { ctx.compact({ onError: error => { writeFileSync(join(dir, "compact-error"), String(error)); } }); } });
  pi.registerShortcut("ctrl+shift+s", { handler: ctx => { savedImages = ctx.ui.getEditorText().match(/\\[recovered image [^\\]]+\\]/g) ?? []; ctx.ui.setEditorText("first-image\\n" + savedImages[0]); mark("split-images"); } });
  pi.registerShortcut("ctrl+shift+t", { handler: ctx => { ctx.ui.setEditorText("tail-image\\n" + savedImages[1]); mark("tail-image-ready"); } });
  pi.registerShortcut("ctrl+shift+j", { handler: () => { pi.sendUserMessage("shutdown-handled"); } });
  pi.on("session_before_compact", async (event, ctx) => {
    if (!process.env.PI_PROOF_CASE.startsWith("r4-")) return;
    if (process.env.PI_PROOF_CASE === "r4-compact-shutdown") { mark("compact-shutdown-requested"); ctx.shutdown(); return { cancel: true }; }
    ctx.ui.setStatus("proof", "R4_COMPACTION_HELD"); mark("compaction-held"); await hold("compaction");
    return { compaction: { summary: "offline compacted context", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
  });
  pi.on("agent_start", async (_event, ctx) => {
    if (process.env.PI_PROOF_CASE.startsWith("recovery") || round4RunHeld) { ctx.ui.setStatus("proof", "RUN_HELD"); mark("run-held"); await hold("run"); }
    if (process.env.PI_PROOF_CASE === "run-shutdown") ctx.shutdown();
  });
  pi.on("input", async (event, ctx) => {
    if (event.text === "run-held" && process.env.PI_PROOF_CASE.startsWith("r4-")) round4RunHeld = true;
    if (event.text === "r4-flush-held") { ctx.ui.setStatus("proof", "R4_FLUSH_INPUT_HELD"); mark("flushed-held"); await hold("flushed"); }
    if (event.text.includes("first-image") || event.text.includes("tail-image")) { writeFileSync(join(dir, event.text.includes("first-image") ? "first-image-proof" : "tail-image-proof"), JSON.stringify({ text: event.text, images: event.images ?? null })); return { action: "handled" }; }
    if (event.text === "held-A") { ctx.ui.setStatus("proof", "INPUT_HELD_A"); mark("input-held"); await hold("input"); }
    if (event.text.includes("large-paste-tail") || (event.text.includes("held-A") && event.text !== "held-A")) { writeFileSync(join(dir, "paste-submitted"), event.text); return { action: "handled" }; }
    if (event.text === "queue-image") { mark("image-created"); return { action: "transform", text: "attached-original", images: [{ type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1S8AAAAASUVORK5CYII=", mimeType: "image/png" }] }; }
    if (event.text.includes("attached-original")) { writeFileSync(join(dir, "image-recovered"), JSON.stringify(event.images ?? null)); return { action: "handled" }; }
    if (event.text === "shutdown-handled") {
      ctx.ui.notify("ADMISSION_SHUTDOWN_REQUESTED"); mark("admission-shutdown"); ctx.shutdown(); return { action: "handled" };
    }
  });
  pi.registerCommand("replace-held", { handler: async (_args, ctx) => {
    const result = await ctx.newSession();
    ctx.ui.notify("REPLACEMENT_RESULT_CANCELLED=" + result.cancelled); mark("replacement-finished");
  } });
  pi.on("session_before_switch", async (_event, ctx) => {
    if (["shortcut-stale", "replacement-shutdown"].includes(process.env.PI_PROOF_CASE)) return;
    ctx.ui.setStatus("proof", "REPLACEMENT_FENCE_HELD"); mark("switch-held"); await hold("switch"); return { cancel: true };
  });
  pi.registerShortcut("ctrl+shift+h", { handler: async (ctx) => {
    const savedNotify = ctx.ui.notify; mark("shortcut-held"); await hold("shortcut");
    const rejected = [];
    for (const [name, action] of [["abort", () => ctx.abort()], ["compact", () => ctx.compact()], ["ui", () => savedNotify("STALE_UI_MUTATED_RECEIVING")]]) {
      try { action(); } catch { rejected.push(name); }
    }
    writeFileSync(join(dir, "shortcut-result"), JSON.stringify(rejected));
  } });
  pi.on("session_shutdown", async (_event, ctx) => { if (process.env.PI_PROOF_CASE === "shutdown-upgrade") { mark("cleanup-held"); await hold("cleanup"); } });
  pi.on("agent_settled", async (_event, ctx) => { ctx.ui.setStatus("proof", "AGENT_SETTLED"); mark("settled"); if (process.env.PI_PROOF_CASE === "busy-settlement") { mark("settlement-held"); await hold("settlement"); } });
}`;

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
function tmux(...args: string[]): string {
	return execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf8" });
}

function editorFrame(frame: string): string {
	const lines = frame.split("\n");
	const borders = lines.flatMap((line, index) => (/^─{20}/.test(line) ? [index] : []));
	if (borders.length < 2) return "";
	return lines
		.slice(borders[borders.length - 2] + 1, borders[borders.length - 1])
		.join("\n")
		.trim();
}

interface TerminalProof {
	dir: string;
	name: string;
	keys(...keys: string[]): void;
	text(text: string): void;
	submit(text: string): void;
	mark(name: string): Promise<void>;
	frame(label: string): string;
	exit(): Promise<number>;
}

// smarty-dev#3048, PR #110 F4/F6/F8: actual bin + PTY + keyboard dispatch, not prototype mocks.
describe.skipIf(!tmuxAvailable || !existsSync(cli))("built CLI real interactive admission", () => {
	const proofs: TerminalProof[] = [];
	afterAll(() => {
		// This file owns the private socket and every pane on its server.
		try {
			tmux("kill-server");
		} catch {}
		rmSync(socket, { force: true });
	});
	afterEach(async () => {
		for (const p of proofs.splice(0)) {
			for (const gate of ["input", "run", "switch", "shortcut", "cleanup", "settlement", "compaction", "flushed"])
				writeFileSync(join(p.dir, `release-${gate}`), "release");
			if (!existsSync(join(p.dir, "exit"))) {
				p.keys("C-c");
				await new Promise((done) => setTimeout(done, 600));
				p.submit("shutdown-handled");
				try {
					await p.exit();
				} catch {
					const pid = Number(readFileSync(join(p.dir, "pid"), "utf8"));
					try {
						process.kill(pid, "SIGKILL");
					} catch {}
					await p.exit();
				}
			}
			p.frame("final");
			if (evidence) {
				for (const file of [
					"shortcut-result",
					"paste-submitted",
					"image-recovered",
					"first-image-proof",
					"tail-image-proof",
					"exit",
				]) {
					if (existsSync(join(p.dir, file)))
						writeFileSync(join(evidence, `tui-${p.name}-${file}.proof`), readFileSync(join(p.dir, file)));
				}
			}
			tmux("kill-session", "-t", p.name);
			rmSync(p.dir, { recursive: true, force: true });
		}
	});

	async function launch(label: string, scenario: string): Promise<TerminalProof> {
		const dir = mkdtempSync(join(tmpdir(), "pi-admission-tui-"));
		mkdirSync(join(dir, "agent"));
		if (scenario.startsWith("r4-"))
			writeFileSync(
				join(dir, "agent", "settings.json"),
				JSON.stringify({ compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1 } }),
			);
		writeFileSync(join(dir, "proof.mjs"), fixture);
		const name = `${prefix}-${label}`;
		tmux("new-session", "-d", "-s", name, "-x", "140", "-y", "50", "-c", dir);
		tmux("set-option", "-s", "extended-keys", "on");
		tmux("pipe-pane", "-t", name, "-o", `cat > ${shellQuote(join(evidence ?? dir, `tui-${name}.ansi.log`))}`);
		const args = [
			cli,
			"--offline",
			"--no-session",
			"--no-tools",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"-e",
			join(dir, "proof.mjs"),
		];
		if (scenario === "initial-shutdown") args.push("shutdown-handled");
		const env = {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			TERM: "tmux-256color",
			LANG: "C.UTF-8",
			HOME: dir,
			USERPROFILE: dir,
			TMPDIR: dir,
			PI_CODING_AGENT_DIR: join(dir, "agent"),
			PI_OFFLINE: "1",
			PI_NO_LOCAL_LLM: "1",
			AWS_EC2_METADATA_DISABLED: "true",
			PI_PROOF_DIR: dir,
			PI_PROOF_CASE: scenario,
			PI_PACKAGE_DIR: resolve("."),
		};
		const command = `set +m; env -i ${Object.entries(env)
			.map(([key, value]) => `${key}=${shellQuote(value)}`)
			.join(
				" ",
			)} nice -n 19 ${shellQuote(process.execPath)} ${args.map(shellQuote).join(" ")} </dev/tty & child=$!; echo "$child" > ${shellQuote(join(dir, "pid"))}; wait "$child"; code=$?; echo "$code" > ${shellQuote(join(dir, "exit"))}; printf '\\nPROOF_EXIT=%s\\n' "$code"`;
		writeFileSync(join(dir, "launch.sh"), `${command}\n`);
		tmux("send-keys", "-t", name, "-l", `bash ${shellQuote(join(dir, "launch.sh"))}`);
		tmux("send-keys", "-t", name, "Enter");
		const p: TerminalProof = {
			dir,
			name,
			keys: (...keys) => {
				tmux("send-keys", "-t", name, ...keys);
			},
			text: (text) => {
				tmux("send-keys", "-t", name, "-l", text);
			},
			submit: (text) => {
				tmux("send-keys", "-t", name, "-l", text);
				tmux("send-keys", "-t", name, "Enter");
			},
			mark: async (mark) => {
				await vi.waitFor(() => expect(existsSync(join(dir, mark)), mark).toBe(true), { timeout: 8000 });
			},
			frame: (label) => {
				const frame = tmux("capture-pane", "-t", name, "-p");
				if (evidence) {
					writeFileSync(join(evidence, `tui-${name}-${label}.txt`), frame);
					const lines = frame
						.split("\n")
						.map(
							(line, index) =>
								`<text x="12" y="${22 + index * 18}">${line.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</text>`,
						)
						.join("\n");
					writeFileSync(
						join(evidence, `tui-${name}-${label}.svg`),
						`<svg xmlns="http://www.w3.org/2000/svg" width="1540" height="940"><rect width="100%" height="100%" fill="#101010"/><g fill="#ededed" font-family="monospace" font-size="16" xml:space="preserve">${lines}</g></svg>`,
					);
				}
				return frame;
			},
			exit: async () => {
				await vi.waitFor(() => expect(existsSync(join(dir, "exit"))).toBe(true), { timeout: 5000 });
				return Number(readFileSync(join(dir, "exit"), "utf8"));
			},
		};
		proofs.push(p);
		await p.mark("ready");
		await new Promise((done) => setTimeout(done, 400));
		p.frame("ready");
		return p;
	}

	it("held Enter input refuses replacement and Escape recovery keeps a newer draft", async () => {
		const p = await launch("draft-recovery", "recovery");
		p.submit("run-held");
		await p.mark("run-held");
		p.submit("queued-C");
		await vi.waitFor(() => expect(p.frame("queued-steering")).toContain("queued-C"));
		p.submit("held-A");
		await p.mark("input-held");
		p.submit("/new");
		await vi.waitFor(() => expect(p.frame("busy-replacement")).toContain("INPUT_ADMISSION_BUSY"));
		p.text("newer-B");
		p.keys("Escape");
		await vi.waitFor(() => {
			const frame = p.frame("draft-recovered");
			expect(editorFrame(frame)).toContain("newer-B");
			expect(editorFrame(frame)).toContain("held-A");
			expect(editorFrame(frame)).toContain("queued-C");
			expect(frame).toContain("INPUT_ADMISSION_ABORTED");
		});
		writeFileSync(join(p.dir, "release-input"), "release");
		writeFileSync(join(p.dir, "release-run"), "release");
		await p.mark("settled");
	});

	it("Alt+Enter and Enter retain editor input while replacement is fenced", async () => {
		const p = await launch("fenced-follow-up", "recovery");
		p.submit("run-held");
		await p.mark("run-held");
		p.submit("/replace-held");
		await p.mark("switch-held");
		p.text("late-follow-up");
		p.keys("M-Enter");
		await vi.waitFor(() => {
			const frame = p.frame("alt-enter-refused");
			expect(frame).toContain("INPUT_ADMISSION_FENCED");
			expect(editorFrame(frame)).toContain("late-follow-up");
		});
		p.keys("Enter");
		await vi.waitFor(() => expect(editorFrame(p.frame("enter-refused"))).toBe("late-follow-up"));
		writeFileSync(join(p.dir, "release-switch"), "release");
		await p.mark("replacement-finished");
		p.keys("Escape");
		writeFileSync(join(p.dir, "release-run"), "release");
		await p.mark("settled");
	});

	// smarty-dev#3048, PR #110 S2: old shortcuts cannot retarget a receiving session or saved UI.
	it("held shortcut rejects abort, compact and captured UI after replacement", async () => {
		const p = await launch("shortcut-stale", "shortcut-stale");
		p.text("[104;6u");
		await p.mark("shortcut-held");
		p.submit("/new");
		await p.mark("start-2");
		await vi.waitFor(() => expect(p.frame("receiving")).toContain("New session started"));
		p.submit("held-A");
		await p.mark("input-held");
		writeFileSync(join(p.dir, "release-shortcut"), "release");
		await p.mark("shortcut-result");
		expect(JSON.parse(readFileSync(join(p.dir, "shortcut-result"), "utf8"))).toEqual(["abort", "compact", "ui"]);
		expect(p.frame("stale-rejected")).not.toContain("STALE_UI_MUTATED_RECEIVING");
		p.keys("Escape");
		writeFileSync(join(p.dir, "release-input"), "release");
	});

	// smarty-dev#3048, PR #110 S3: real signals must latch terminal shutdown during busy ownership.
	it.each([
		["SIGTERM", "admission"],
		["SIGHUP", "admission"],
		["SIGTERM", "replacement"],
		["SIGHUP", "replacement"],
	] as const)("%s terminates held %s without swallowing the request", async (signal, phase) => {
		const p = await launch(`signal-${signal}-${phase}`, "signal");
		p.submit(phase === "admission" ? "held-A" : "/new");
		await p.mark(phase === "admission" ? "input-held" : "switch-held");
		p.frame("signal-pending");
		process.kill(Number(readFileSync(join(p.dir, "pid"), "utf8")), signal);
		expect(await p.exit()).toBe(0);
		p.frame("signal-exited");
	});

	// smarty-dev#3048, PR #110 R2-1/S3: BUSY replacement must retain the active settlement cancellation owner.
	it("SIGTERM after BUSY replacement cancels the original settlement", async () => {
		const p = await launch("busy-settlement", "busy-settlement");
		p.submit("settlement-run");
		await p.mark("settlement-held");
		p.submit("/new");
		await vi.waitFor(() => expect(p.frame("settlement-busy")).toContain("INPUT_ADMISSION_BUSY"));
		p.text("newer-settlement-draft");
		process.kill(Number(readFileSync(join(p.dir, "pid"), "utf8")), "SIGTERM");
		expect(await p.exit()).toBe(0);
		expect(p.frame("settlement-cancelled")).toContain("newer-settlement-draft");
	});
	// smarty-dev#3048, PR #110 S3/S11: terminal rejection preserves acknowledged queued image data and newer draft.
	it("SIGTERM returns complete queued attachments and the editor draft", async () => {
		const p = await launch("signal-queued-image", "recovery-signal-queues");
		p.submit("run-held");
		await p.mark("run-held");
		p.text("queue-image");
		p.keys("M-Enter");
		await p.mark("image-created");
		await vi.waitFor(() => expect(p.frame("image-queued")).toContain("attached-original"));
		p.text("newer-signal-draft");
		process.kill(Number(readFileSync(join(p.dir, "pid"), "utf8")), "SIGTERM");
		expect(await p.exit()).toBe(0);
		const frame = p.frame("queued-image-rejected");
		expect(frame).toContain("newer-signal-draft");
		{
			let receipt: { text: string; images: unknown[] } | undefined;
			await vi.waitFor(() => {
				const raw = readFileSync(join(evidence ?? p.dir, `tui-${p.name}.ansi.log`), "utf8");
				const json = /INPUT_ADMISSION_SHUTDOWN: recovered draft (\{[^\r\n]+\})/.exec(raw)?.[1];
				expect(json).toBeDefined();
				receipt = JSON.parse(json!) as { text: string; images: unknown[] };
			});
			expect(receipt?.text).toContain("attached-original");
			expect(receipt?.text).toContain("newer-signal-draft");
			expect(receipt?.images).toEqual([
				{
					type: "image",
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1S8AAAAASUVORK5CYII=",
					mimeType: "image/png",
				},
			]);
			if (evidence) writeFileSync(join(evidence, `tui-${p.name}-recovery.proof.json`), JSON.stringify(receipt));
		}
	});
	// smarty-dev#3048, PR #110 S3: a signal upgrades an ordinary quit already awaiting teardown.
	it("SIGTERM upgrades an in-progress ordinary shutdown", async () => {
		const p = await launch("shutdown-upgrade", "shutdown-upgrade");
		p.submit("/quit");
		await p.mark("cleanup-held");
		p.frame("cleanup-pending");
		process.kill(Number(readFileSync(join(p.dir, "pid"), "utf8")), "SIGTERM");
		expect(await p.exit()).toBe(0);
		p.frame("cleanup-cancelled");
	});
	// smarty-dev#3048, PR #110 R2-3/S10/S8: idle Escape and collapsed bracketed paste must be lossless.
	it.each(["Enter", "M-Enter", "streaming"] as const)(
		"%s admission Escape preserves a newer large paste",
		async (key) => {
			const p = await launch(`paste-${key}`, key === "streaming" ? "recovery-paste" : "idle");
			if (key === "streaming") {
				p.submit("run-held");
				await p.mark("run-held");
			}
			p.text("held-A");
			p.keys(key === "streaming" ? "Enter" : key);
			await p.mark("input-held");
			const paste = `${"large-paste-body ".repeat(90)}large-paste-tail`;
			p.text(`\x1b[200~${paste}\x1b[201~`);
			await vi.waitFor(() => expect(editorFrame(p.frame("collapsed-paste"))).toContain("[paste #"));
			p.keys("Escape");
			await vi.waitFor(() => {
				const frame = p.frame("paste-recovered");
				expect(frame).toContain("INPUT_ADMISSION_ABORTED");
				expect(editorFrame(frame)).toContain("held-A");
			});
			writeFileSync(join(p.dir, "release-input"), "release");
			if (key === "streaming") {
				writeFileSync(join(p.dir, "release-run"), "release");
				await p.mark("settled");
			}
			p.keys("Enter");
			await p.mark("paste-submitted");
			expect(readFileSync(join(p.dir, "paste-submitted"), "utf8")).toBe(`${paste}\nheld-A`);
			p.frame("paste-resubmitted");
		},
	);

	// smarty-dev#3048, PR #110 R2-4/S9: no later run or keyboard prompt may be needed to exit.
	it.each(["replacement-shutdown", "initial-shutdown"] as const)(
		"deferred %s exits without starting a run",
		async (scenario) => {
			const p = await launch(scenario, scenario);
			if (scenario === "replacement-shutdown") {
				p.submit("/new");
				await p.mark("replacement-shutdown");
			} else await p.mark("admission-shutdown");
			p.frame("deferred-shutdown");
			expect(await p.exit()).toBe(0);
			p.frame("deferred-exited");
		},
	);

	// smarty-dev#3048, PR #110 S11: acknowledged image recovery cannot rely on rerunning a transform.
	it("Escape recovers the original queued image and resubmits it intact", async () => {
		const p = await launch("queued-image", "recovery");
		p.submit("run-held");
		await p.mark("run-held");
		p.submit("queue-image");
		await p.mark("image-created");
		await vi.waitFor(() => expect(p.frame("image-queued")).toContain("attached-original"));
		p.keys("Escape");
		await vi.waitFor(() => expect(editorFrame(p.frame("image-recovered"))).toContain("attached-original"));
		writeFileSync(join(p.dir, "release-run"), "release");
		await p.mark("settled");
		p.keys("Enter");
		await p.mark("image-recovered");
		expect(JSON.parse(readFileSync(join(p.dir, "image-recovered"), "utf8"))).toEqual([
			{
				type: "image",
				data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1S8AAAAASUVORK5CYII=",
				mimeType: "image/png",
			},
		]);
		p.frame("image-resubmitted");
	});
	// smarty-dev#3048 / PR #110 R3-4: terminal teardown preserves unsent collapsed paste bytes.
	it.each(["SIGTERM", "SIGHUP"] as const)("round4 %s returns exact idle collapsed draft", async (signal) => {
		const p = await launch(`idle-paste-${signal}`, "idle");
		const paste = `${"unsent-large-paste ".repeat(90)}large-paste-tail`;
		p.text(`\x1b[200~${paste}\x1b[201~`);
		await vi.waitFor(() => expect(editorFrame(p.frame("collapsed-unsent-paste"))).toContain("[paste #"));
		process.kill(Number(readFileSync(join(p.dir, "pid"), "utf8")), signal);
		expect(await p.exit()).toBe(0);
		p.frame("paste-receipt");
		await vi.waitFor(() => {
			const raw = readFileSync(join(evidence ?? p.dir, `tui-${p.name}.ansi.log`), "utf8");
			const json = /INPUT_ADMISSION_SHUTDOWN: recovered draft (\{[^\r\n]+\})/.exec(raw)?.[1];
			expect(json).toBeDefined();
			expect(JSON.parse(json!).text).toBe(paste);
		});
	});
	// smarty-dev#3048 / PR #110 R3-5: a detached compaction prompt must restore before terminal receipt.
	it.each(["SIGTERM", "SIGHUP"] as const)("round4 %s recovers held compaction flush input", async (signal) => {
		const p = await launch(`compaction-flush-${signal}`, "r4-flush-signal");
		p.submit("seed");
		await p.mark("settled");
		p.text("\x1b[67;6u");
		await p.mark("compaction-held");
		p.submit("r4-flush-held");
		await vi.waitFor(() => expect(p.frame("compaction-staged")).toContain("Steering: r4-flush-held"));
		writeFileSync(join(p.dir, "release-compaction"), "release");
		await p.mark("flushed-held");
		p.frame("flush-admission-held");
		process.kill(Number(readFileSync(join(p.dir, "pid"), "utf8")), signal);
		expect(await p.exit()).toBe(0);
		p.frame("flush-recovered");
		await vi.waitFor(() => {
			const raw = readFileSync(join(evidence ?? p.dir, `tui-${p.name}.ansi.log`), "utf8");
			const json = /INPUT_ADMISSION_SHUTDOWN: recovered draft (\{[^\r\n]+\})/.exec(raw)?.[1];
			expect(json).toBeDefined();
			expect(JSON.parse(json!).text).toBe("r4-flush-held");
		});
	});
	// smarty-dev#3048 / PR #110 R3-6 (security R3-S6): original image ownership across every compaction branch.
	it.each(["manual", "retry"] as const)(
		"round4 %s compaction preserves first and tail recovered images",
		async (kind) => {
			const p = await launch(`images-${kind}`, `r4-images-${kind}`);
			p.submit("seed");
			await p.mark("settled");
			p.submit("run-held");
			await p.mark("run-held");
			for (let index = 0; index < 2; index++) {
				p.text("queue-image");
				p.keys("M-Enter");
				await vi.waitFor(() =>
					expect(p.frame(`image-queued-${index}`).split("attached-original").length).toBeGreaterThan(index + 1),
				);
			}
			p.keys("M-Up");
			await vi.waitFor(() => expect(editorFrame(p.frame("images-dequeued"))).toContain("[recovered image"));
			p.text("\x1b[83;6u");
			await p.mark("split-images");
			if (kind === "manual") p.text("\x1b[67;6u");
			writeFileSync(join(p.dir, "release-run"), "release");
			await p.mark("compaction-held");
			p.keys("Enter");
			p.text("\x1b[84;6u");
			await p.mark("tail-image-ready");
			p.keys("M-Enter");
			await vi.waitFor(() => expect(p.frame("image-compaction-staging")).toContain("Follow-up: tail-image"));
			writeFileSync(join(p.dir, "release-compaction"), "release");
			await p.mark("first-image-proof");
			await p.mark("tail-image-proof");
			for (const slot of ["first", "tail"]) {
				const proof = JSON.parse(readFileSync(join(p.dir, `${slot}-image-proof`), "utf8"));
				expect(proof.text).not.toContain("[recovered image");
				expect(proof.images).toEqual([
					{
						type: "image",
						data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1S8AAAAASUVORK5CYII=",
						mimeType: "image/png",
					},
				]);
			}
			p.frame("image-compaction-transferred");
		},
	);
	// smarty-dev#3048 / PR #110 R3-7: extension-origin no-run completion must retry the latched shutdown.
	it.each(["extension-input", "compact"] as const)(
		"round4 no-run %s shutdown exits without another key",
		async (kind) => {
			const p = await launch(`no-run-${kind}`, kind === "compact" ? "r4-compact-shutdown" : "idle");
			if (kind === "compact") {
				p.submit("seed");
				await p.mark("settled");
				p.submit("/compact");
				await p.mark("compact-shutdown-requested");
			} else {
				p.text("\x1b[74;6u");
				await p.mark("admission-shutdown");
			}
			p.frame("no-run-shutdown-requested");
			expect(await p.exit()).toBe(0);
			p.frame("no-run-exited");
		},
	);

	it.each(["run-shutdown", "admission-shutdown"] as const)(
		"extension-requested %s exits the real interactive loop",
		async (scenario) => {
			const p = await launch(scenario, scenario);
			p.submit(scenario === "run-shutdown" ? "shutdown-run" : "shutdown-handled");
			await p.mark(scenario === "run-shutdown" ? "settled" : "admission-shutdown");
			p.frame("shutdown-requested");
			expect(await p.exit()).toBe(0);
			expect(p.frame("exited")).toContain("PROOF_EXIT=0");
		},
	);
});
