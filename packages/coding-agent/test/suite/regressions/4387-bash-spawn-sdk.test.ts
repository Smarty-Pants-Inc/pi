import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { type BashSpawnEvent, createAgentSession, ModelRuntime } from "../../../src/index.ts";
import { getMessageText } from "../harness.ts";

// Luna PR #140 round 3 P2: prove the gate through the public SDK entry point, not createHarness. Normal extension
// discovery loads the guard from <agentDir>/extensions, the prefix comes from <agentDir>/settings.json, and an
// offline faux model issues the bash tool calls. Mirrors round 2's `dist/bundle/cli.js --offline -p` F2 evidence.
const PREFIX = "mktemp(){ printf '%s\\n' \"$PWD/redirected-grant\"; }";
const ALLOCATOR_COMMAND = 'allocated=$(mktemp); printf allocated > "$allocated"';

const GUARD_EXTENSION = `import { appendFileSync } from "node:fs";
import { join } from "node:path";

export default function (pi) {
	let raw = "";
	pi.on("tool_call", (event) => {
		if (event.toolName === "bash") raw = event.input.command;
	});
	pi.on("bash_spawn", (event) => {
		appendFileSync(join(event.cwd, "guard-events.jsonl"), JSON.stringify(event) + "\\n");
		// A tool_call grant for an allocator only attests the final executor when nothing was prepended to it.
		if (/\\bmktemp\\b/.test(raw) && event.command !== raw) {
			return { block: true, reason: "guard: allocator grant does not attest final executor" };
		}
	});
}
`;

describe("bash_spawn through the public createAgentSession entry point", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	it("a disk-loaded guard allows ordinary commands and vetoes prefixed allocator substitution with no marker", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-4387-sdk-")));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const cwd = join(root, "work");
		const agentDir = join(root, "agent");
		mkdirSync(cwd);
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(join(agentDir, "extensions", "guard.ts"), GUARD_EXTENSION);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ shellCommandPrefix: PREFIX }));

		const modelRuntime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const faux = fauxProvider({ models: [{ id: "scripted", contextWindow: 100_000, maxTokens: 1000 }] });
		modelRuntime.registerNativeProvider(faux.provider);
		await modelRuntime.refresh({ allowNetwork: false });

		const { session, extensionsResult } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			model: modelRuntime.getModel("faux", "scripted"),
		});
		cleanups.push(() => session.dispose());
		expect(extensionsResult.errors).toEqual([]);
		expect(extensionsResult.extensions.map((extension) => extension.path)).toEqual([
			join(agentDir, "extensions", "guard.ts"),
		]);
		expect(session.settingsManager.getShellCommandPrefix()).toBe(PREFIX);

		const allowedFile = join(cwd, "allowed-file");
		const marker = join(cwd, "redirected-grant");
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "printf allowed > allowed-file" }, { id: "allowed" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("bash", { command: ALLOCATOR_COMMAND }, { id: "allocator" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await session.prompt("run both commands");

		const results = session.messages.filter((message) => message.role === "toolResult");
		expect(results.map((result) => [result.toolCallId, result.isError])).toEqual([
			["allowed", false],
			["allocator", true],
		]);
		// (a) The ordinary command ran through the prefixed final executor and created its real file.
		expect(readFileSync(allowedFile, "utf8")).toBe("allowed");
		// (b) The allocator-substitution command was vetoed before spawn: no redirected marker exists.
		expect(getMessageText(results[1])).toContain("guard: allocator grant does not attest final executor");
		expect(existsSync(marker)).toBe(false);

		const events = readFileSync(join(cwd, "guard-events.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as BashSpawnEvent);
		expect(events.map((event) => [event.toolCallId, event.command, event.backend])).toEqual([
			["allowed", `${PREFIX}\nprintf allowed > allowed-file`, "local-builtin"],
			["allocator", `${PREFIX}\n${ALLOCATOR_COMMAND}`, "local-builtin"],
		]);
		for (const event of events) expect(event.shellPath?.startsWith("/")).toBe(true);
	});
});
