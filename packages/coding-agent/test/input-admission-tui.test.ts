import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const cli = process.env.PI_ADMISSION_CLI ?? resolve("dist/bundle/cli.js");
const fauxPath = resolve("../ai/dist/providers/faux.js");
const socket = `pi-admission-${process.pid}`;
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
  faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage("offline terminal answer")));
  // Synthetic in-memory auth is never read from a credential store or sent over a network.
  pi.registerProvider(faux.provider, { baseUrl: faux.getModel().baseUrl, apiKey: "offline-faux-test-only", api: faux.api, streamSimple: faux.streamSimple, models: faux.models });
  pi.on("session_start", async (_event, ctx) => {
    await pi.setModel(faux.getModel());
    ctx.ui.setStatus("proof", "OFFLINE_PROOF_READY"); mark("ready");
  });
  pi.on("agent_start", async (_event, ctx) => {
    if (process.env.PI_PROOF_CASE === "recovery") { ctx.ui.setStatus("proof", "RUN_HELD"); mark("run-held"); await hold("run"); }
    if (process.env.PI_PROOF_CASE === "run-shutdown") ctx.shutdown();
  });
  pi.on("input", async (event, ctx) => {
    if (event.text === "held-A") { ctx.ui.setStatus("proof", "INPUT_HELD_A"); mark("input-held"); await hold("input"); }
    if (event.text === "shutdown-handled") {
      ctx.ui.notify("ADMISSION_SHUTDOWN_REQUESTED"); mark("admission-shutdown"); ctx.shutdown(); return { action: "handled" };
    }
  });
  pi.registerCommand("replace-held", { handler: async (_args, ctx) => {
    const result = await ctx.newSession();
    ctx.ui.notify("REPLACEMENT_RESULT_CANCELLED=" + result.cancelled); mark("replacement-finished");
  } });
  pi.on("session_before_switch", async (_event, ctx) => {
    ctx.ui.setStatus("proof", "REPLACEMENT_FENCE_HELD"); mark("switch-held"); await hold("switch"); return { cancel: true };
  });
  pi.on("agent_settled", (_event, ctx) => { ctx.ui.setStatus("proof", "AGENT_SETTLED"); mark("settled"); });
}`;

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
function tmux(...args: string[]): string {
	return execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
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
	afterEach(async () => {
		for (const p of proofs.splice(0)) {
			for (const gate of ["input", "run", "switch"]) writeFileSync(join(p.dir, `release-${gate}`), "release");
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
			tmux("kill-session", "-t", p.name);
			rmSync(p.dir, { recursive: true, force: true });
		}
	});

	async function launch(label: string, scenario: string): Promise<TerminalProof> {
		const dir = mkdtempSync(join(tmpdir(), "pi-admission-tui-"));
		mkdirSync(join(dir, "agent"));
		writeFileSync(join(dir, "proof.mjs"), fixture);
		const name = `${prefix}-${label}`;
		tmux("new-session", "-d", "-s", name, "-x", "140", "-y", "50", "-c", dir);
		tmux("set-option", "-s", "extended-keys", "on");
		if (evidence) tmux("pipe-pane", "-t", name, "-o", `cat > ${shellQuote(join(evidence, `tui-${name}.ansi.log`))}`);
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
