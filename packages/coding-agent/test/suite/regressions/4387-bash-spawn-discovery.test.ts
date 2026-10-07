import * as fs from "node:fs";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import * as childProcess from "child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import type { BashSpawnEvent } from "../../../src/index.ts";
import { getPowerShellConfig, getShellConfig } from "../../../src/utils/shell.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

vi.mock("child_process", { spy: true });
vi.mock("node:fs", { spy: true });
const { existsSync } = await vi.importActual<typeof import("node:fs")>("node:fs");

// Astra PR #140 F1: shell discovery must not execute a PATH/CWD-resolved helper (`which`/`where`) before bash_spawn.
describe("bash_spawn shell discovery runs nothing before admission", () => {
	const harnesses: Harness[] = [];
	const originalPath = process.env.PATH;
	const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

	afterEach(() => {
		process.env.PATH = originalPath;
		Object.defineProperty(process, "platform", originalPlatform);
		vi.restoreAllMocks();
		vi.clearAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	function plantDiscoveryTrap(dir: string, names: string[]): string {
		const marker = join(dir, "discovery-ran");
		mkdirSync(join(dir, "evil"), { recursive: true });
		for (const name of names) {
			const helper = join(dir, "evil", name);
			writeFileSync(helper, `#!/bin/sh\nprintf ran > '${marker}'\nprintf '/bin/sh\\n'\n`);
			chmodSync(helper, 0o755);
		}
		return marker;
	}

	it("Unix PATH fallback resolves bash without running `which`, so a veto leaves no discovery or command child", async () => {
		const realBash = childProcess.execFileSync("/bin/sh", ["-c", "command -v bash"], { encoding: "utf-8" }).trim();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("bash_spawn", (event) => {
						events.push(event);
						return { block: true, reason: "policy denied spawn" };
					});
				},
			],
		});
		harnesses.push(harness);
		const events: BashSpawnEvent[] = [];
		const marker = plantDiscoveryTrap(harness.tempDir, ["which"]);
		// Force the fallback that used to run `which`: no /bin/bash, a workspace-controlled helper first on PATH.
		vi.mocked(fs.existsSync).mockImplementation((path) => path !== "/bin/bash" && existsSync(path));
		process.env.PATH = ["relative-dir", "", join(harness.tempDir, "evil"), dirname(realBash)].join(":");
		const spawnSync = vi.mocked(childProcess.spawnSync);
		const spawn = vi.mocked(childProcess.spawn);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "printf created > veto-marker" }, { id: "c1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("run it");
		const result = harness.session.messages.find((message) => message.role === "toolResult");

		expect(getMessageText(result)).toContain("policy denied spawn");
		expect(existsSync(marker)).toBe(false);
		expect(spawnSync).not.toHaveBeenCalled();
		expect(spawn).not.toHaveBeenCalled();
		expect(existsSync(join(harness.tempDir, "veto-marker"))).toBe(false);
		expect(events).toHaveLength(1);
		expect(events[0]?.shellPath).toBe(realBash);
	});

	// Luna PR #140 round 3 P1: the sh fallback must be an absolute path from the execution PATH, never bare "sh".
	function plantSh(dir: string, marker: string): void {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "sh"), `#!/bin/sh\nprintf ran > '${marker}'\nexec /bin/sh "$@"\n`);
		chmodSync(join(dir, "sh"), 0o755);
	}

	it("Unix sh fallback attests and spawns the same absolute sh from the execution PATH, never a relative entry", async () => {
		const events: BashSpawnEvent[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("bash_spawn", (event) => {
						events.push(event);
					});
				},
			],
		});
		harnesses.push(harness);
		vi.stubEnv(ENV_AGENT_DIR, join(harness.tempDir, "agent"));
		const fakeBin = join(harness.tempDir, "fake-bin");
		const relativeBin = join(harness.tempDir, "relative-bin");
		const fakeMarker = join(harness.tempDir, "fake-sh-ran");
		const relativeMarker = join(harness.tempDir, "relative-sh-ran");
		plantSh(fakeBin, fakeMarker);
		plantSh(relativeBin, relativeMarker);
		// No bash anywhere: /bin/bash hidden and no PATH entry holds bash. A relative entry (resolved from the
		// process cwd) and an empty entry precede the absolute directory holding the real fallback `sh`.
		vi.mocked(fs.existsSync).mockImplementation((path) => path !== "/bin/bash" && existsSync(path));
		process.env.PATH = [relative(process.cwd(), relativeBin), "", fakeBin].join(":");
		const spawn = vi.mocked(childProcess.spawn);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "printf fallback" }, { id: "c1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("run it");
		const result = harness.session.messages.find((message) => message.role === "toolResult");

		expect(events).toHaveLength(1);
		expect(events[0]?.shellPath).toBe(join(fakeBin, "sh"));
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(spawn.mock.calls[0]?.[0]).toBe(events[0]?.shellPath);
		expect(getMessageText(result)).toBe("fallback");
		expect(existsSync(fakeMarker)).toBe(true);
		expect(existsSync(relativeMarker)).toBe(false);
	});

	it("Unix sh fallback fails closed when the execution PATH has no absolute sh", () => {
		const dir = fs.mkdtempSync(join(fs.realpathSync(process.env.TMPDIR ?? "/tmp"), "pi-4387-sh-"));
		try {
			const relativeMarker = join(dir, "relative-sh-ran");
			plantSh(join(dir, "relative-bin"), relativeMarker);
			vi.mocked(fs.existsSync).mockImplementation((path) => path !== "/bin/bash" && existsSync(path));
			const env = { PATH: [relative(process.cwd(), join(dir, "relative-bin")), "", join(dir, "empty")].join(":") };
			expect(() => getShellConfig(undefined, env)).toThrow("No bash or sh shell found");
			expect(existsSync(relativeMarker)).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("Windows PATH fallback resolves bash.exe and PowerShell without running `where`", () => {
		const dir = fs.mkdtempSync(join(fs.realpathSync(process.env.TMPDIR ?? "/tmp"), "pi-4387-win-"));
		try {
			const marker = plantDiscoveryTrap(dir, ["where", "where.exe"]);
			const bin = join(dir, "bin");
			mkdirSync(bin);
			for (const name of ["bash.exe", "powershell.exe"]) writeFileSync(join(bin, name), "");
			const savedProgramFiles = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]];
			delete process.env.ProgramFiles;
			delete process.env["ProgramFiles(x86)"];
			Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
			// Single entries so the platform delimiter does not matter on the host running this test.
			process.env.PATH = join(dir, "evil");
			const spawnSync = vi.mocked(childProcess.spawnSync);
			try {
				expect(() => getShellConfig()).toThrow("No bash shell found");
				process.env.PATH = bin;
				expect(getShellConfig()).toEqual({ shell: join(bin, "bash.exe"), args: ["-c"] });
				expect(getPowerShellConfig().shell).toBe(join(bin, "powershell.exe"));
			} finally {
				if (savedProgramFiles[0] !== undefined) process.env.ProgramFiles = savedProgramFiles[0];
				if (savedProgramFiles[1] !== undefined) process.env["ProgramFiles(x86)"] = savedProgramFiles[1];
			}
			expect(spawnSync).not.toHaveBeenCalled();
			expect(existsSync(marker)).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
