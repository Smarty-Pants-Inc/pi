import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { streamSimple, type ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { readCodemodeStore } from "../../src/extensions/codemode/execute.ts";
import { CODEMODE_STORE_ENTRY_TYPE } from "../../src/extensions/codemode/tool.ts";
import {
	AgentSession,
	type CustomEntry,
	convertToLlm,
	createCodemodeExtension,
	type FileEntry,
	SessionManager,
	SettingsManager,
} from "../../src/index.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

const reservedKeys = [
	"__proto__",
	"constructor",
	"prototype",
	"toString",
	"hasOwnProperty",
	"__defineGetter__",
	"toJSON",
	"",
];

async function run(session: AgentSession, harness: Harness, code: string): Promise<unknown> {
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await session.prompt("run the store regression");
	expect(harness.getPendingResponseCount()).toBe(0);
	const result = session.messages.findLast(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "codemode",
	);
	if (!result) throw new Error("No codemode tool result");
	expect(result.isError).toBe(false);
	const [header, ...output] = result.content;
	expect(header).toEqual({
		type: "text",
		text: expect.stringMatching(/^Script completed\nWall time \d+\.\d seconds\nOutput:\n$/),
	});
	return JSON.parse(output.map((part) => (part.type === "text" ? part.text : "")).join("\n")) as unknown;
}

function storeEntries(manager: SessionManager): CustomEntry[] {
	return manager
		.getBranch()
		.filter(
			(entry): entry is CustomEntry => entry.type === "custom" && entry.customType === CODEMODE_STORE_ENTRY_TYPE,
		);
}

describe("codemode store session-file resume", () => {
	const harnesses: Harness[] = [];
	const reopened: AgentSession[] = [];

	afterEach(() => {
		while (reopened.length > 0) reopened.pop()?.dispose();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(active = true): Promise<Harness> {
		const harness = await createHarness({
			persistSession: true,
			initialActiveToolNames: active ? ["codemode"] : undefined,
			extensionFactories: [createCodemodeExtension()],
		});
		harnesses.push(harness);
		return harness;
	}

	async function reopen(harness: Harness, path: string): Promise<AgentSession> {
		const manager = SessionManager.open(path, harness.tempDir);
		const extensionsResult = await createTestExtensionsResult([createCodemodeExtension()], harness.tempDir);
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "faux-key",
				streamFn: streamSimple,
				convertToLlm,
				initialState: { model: harness.getModel(), systemPrompt: "", tools: [] },
			}),
			sessionManager: manager,
			settingsManager: SettingsManager.inMemory(),
			cwd: harness.tempDir,
			modelRuntime: harness.session.modelRuntime,
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			initialActiveToolNames: ["codemode"],
		});
		reopened.push(session);
		expect(session).not.toBe(harness.session);
		expect(session.agent).not.toBe(harness.session.agent);
		expect(session.sessionManager).not.toBe(harness.sessionManager);
		expect(session.sessionFile).toBe(path);
		return session;
	}

	// #2241 A14: exercise guest writes, real JSONL persistence, and a fresh public session reading the file.
	it("preserves reserved own keys and values across close/reopen, then persists ordinary deletion", async () => {
		const prototypeKeys = Reflect.ownKeys(Object.prototype);
		const prototypeDescriptors = Object.getOwnPropertyDescriptors(Object.prototype);
		const prototypeParent = Object.getPrototypeOf(Object.prototype);
		const harness = await setup();
		harness.sessionManager.appendCustomEntry(CODEMODE_STORE_ENTRY_TYPE, { set: { existing: 7 }, delete: [] });
		const values = Object.fromEntries(reservedKeys.map((key, index) => [key, { key, index }]));
		const expectedPairs = Object.entries(values);
		expect(
			await run(
				harness.session,
				harness,
				`const entries = ${JSON.stringify(expectedPairs)};
				for (const [key, value] of entries) store(key, value);
				store("normal", load("existing") + 1);
				return entries.map(([key]) => [key, load(key)]);`,
			),
		).toEqual(expectedPairs);
		const path = harness.session.sessionFile;
		if (!path) throw new Error("No file-backed session");
		const bytes = readFileSync(path, "utf8");
		const records = bytes
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line) as FileEntry);
		const last = records.at(-1);
		if (!last || last.type === "session") throw new Error("No persisted conversation entry");
		harness.session.dispose();
		// #2241: this valid disk-only entry is absent from the old manager; resume cannot pass by reusing its objects.
		appendFileSync(
			path,
			`${JSON.stringify({
				type: "custom",
				id: "disk-only",
				parentId: last.id,
				timestamp: new Date().toISOString(),
				customType: CODEMODE_STORE_ENTRY_TYPE,
				data: { set: { diskOnly: "read-from-persisted-bytes" }, delete: [] },
			})}\n`,
		);
		expect(harness.sessionManager.getEntry("disk-only")).toBeUndefined();
		const session = await reopen(harness, path);
		const written = storeEntries(session.sessionManager)[1]?.data as {
			set: Record<string, unknown>;
			delete: string[];
		};
		for (const key of reservedKeys) {
			expect(Object.hasOwn(written.set, key), `persisted store lost own key ${JSON.stringify(key)}`).toBe(true);
			expect(Object.getOwnPropertyDescriptor(written.set, key)?.value).toEqual(values[key]);
		}
		expect(Reflect.ownKeys(written.set).sort()).toEqual([...reservedKeys, "normal"].sort());
		expect(Object.getPrototypeOf(written.set)).toBe(Object.prototype);
		const snapshot = readCodemodeStore(session.sessionManager.getBranch());
		expect(Reflect.ownKeys(snapshot).sort()).toEqual([...reservedKeys, "existing", "normal", "diskOnly"].sort());
		for (const key of reservedKeys) expect(Object.hasOwn(snapshot, key)).toBe(true);
		expect(Object.getPrototypeOf(snapshot)).toBe(Object.prototype);
		const snapshotKeys = Reflect.ownKeys(snapshot);
		const snapshotDescriptors = Object.getOwnPropertyDescriptors(snapshot);
		expect(
			await run(
				session,
				harness,
				`return { pairs: ${JSON.stringify(reservedKeys)}.map(key => [key, load(key)]),
				existing: load("existing"), normal: load("normal"), diskOnly: load("diskOnly") };`,
			),
		).toEqual({ pairs: expectedPairs, existing: 7, normal: 8, diskOnly: "read-from-persisted-bytes" });
		expect(await run(session, harness, 'store("normal", undefined); return load("normal") === undefined;')).toBe(
			true,
		);
		expect(storeEntries(session.sessionManager).at(-1)?.data).toEqual({ set: {}, delete: ["normal"] });
		session.dispose();
		const afterDelete = await reopen(harness, path);
		expect(
			await run(
				afterDelete,
				harness,
				`return { missing: load("normal") === undefined, existing: load("existing"),
				pairs: ${JSON.stringify(reservedKeys)}.map(key => [key, load(key)]) };`,
			),
		).toEqual({ missing: true, existing: 7, pairs: expectedPairs });
		// #2241: subsequent guest reads/deletes cannot mutate the earlier host snapshot or its prototype.
		expect(Reflect.ownKeys(snapshot)).toEqual(snapshotKeys);
		expect(Object.getOwnPropertyDescriptors(snapshot)).toEqual(snapshotDescriptors);
		expect(Object.getPrototypeOf(snapshot)).toBe(Object.prototype);
		expect(Reflect.ownKeys(Object.prototype)).toEqual(prototypeKeys);
		expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(prototypeDescriptors);
		expect(Object.getPrototypeOf(Object.prototype)).toBe(prototypeParent);
	});

	// #2241 A14 countercase: an ordinary existing key still loads, updates, and deletes after real resume.
	it("keeps ordinary existing store sessions compatible", async () => {
		const harness = await setup();
		harness.sessionManager.appendCustomEntry(CODEMODE_STORE_ENTRY_TYPE, { set: { count: 40 }, delete: [] });
		expect(await run(harness.session, harness, 'store("count", load("count") + 1); return load("count");')).toBe(41);
		const path = harness.session.sessionFile;
		if (!path) throw new Error("No file-backed session");
		harness.session.dispose();
		const session = await reopen(harness, path);
		expect(await run(session, harness, 'store("count", load("count") + 1); return load("count");')).toBe(42);
		expect(await run(session, harness, 'store("count", undefined); return load("count") === undefined;')).toBe(true);
	});

	// #2241 A14 countercase: valid pre-system-message v2 JSONL migrates and its owned reserved data remains loadable.
	it("loads an older valid session without dropping a preexisting reserved key", async () => {
		const harness = await setup();
		const path = join(harness.tempDir, "older-valid.jsonl");
		writeFileSync(
			path,
			`${JSON.stringify({
				type: "session",
				version: 2,
				id: "older-valid",
				timestamp: "2024-01-01T00:00:00.000Z",
				cwd: harness.tempDir,
			})}\n` +
				'{"type":"message","id":"old-user","parentId":null,"timestamp":"2024-01-01T00:00:01.000Z","message":{"role":"user","content":"old conversation","timestamp":1704067201000}}\n' +
				'{"type":"custom","id":"old-store","parentId":"old-user","timestamp":"2024-01-01T00:00:02.000Z","customType":"codemode-store","data":{"set":{"__proto__":{"legacy":true},"constructor":"legacy-constructor","count":40,"normal":"delete-me"},"delete":[]}}\n',
		);
		harness.session.dispose();
		const session = await reopen(harness, path);
		expect(session.sessionManager.getHeader()?.version).toBe(3);
		const snapshot = readCodemodeStore(session.sessionManager.getBranch());
		expect(Object.hasOwn(snapshot, "__proto__")).toBe(true);
		expect(Object.getPrototypeOf(snapshot)).toBe(Object.prototype);
		expect(
			await run(
				session,
				harness,
				`const before = [load("__proto__"), load("constructor"), load("count"), load("normal")];
				store("count", load("count") + 1); store("normal", undefined);
				return { before, next: load("count"), deleted: load("normal") === undefined };`,
			),
		).toEqual({ before: [{ legacy: true }, "legacy-constructor", 40, "delete-me"], next: 41, deleted: true });
		session.dispose();
		const again = await reopen(harness, path);
		expect(
			await run(
				again,
				harness,
				'return [load("__proto__"), load("constructor"), load("count"), load("normal") === undefined];',
			),
		).toEqual([{ legacy: true }, "legacy-constructor", 41, true]);
	});

	// #2241 A14 countercase: loading the real extension does not activate CodeMode without the explicit test opt-in.
	it("leaves codemode inactive by default", async () => {
		const harness = await setup(false);
		expect(harness.session.getAllTools().map((tool) => tool.name)).toContain("codemode");
		expect(harness.session.getActiveToolNames()).not.toContain("codemode");
	});
});
