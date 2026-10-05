import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentTool, type AgentToolResult, runToolCall } from "@earendil-works/pi-agent-core";
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";

const model: Model<"openai-completions"> = {
	id: "synthetic",
	name: "Synthetic",
	api: "openai-completions",
	provider: "audit",
	baseUrl: "https://mock.invalid",
	input: ["text"],
	reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 128,
};
const usage = {
	input: 7,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 9,
	cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
};
const symbol = Symbol("completed-receipt");
const variants = {
	aggregate: () =>
		Object.assign(
			new AggregateError([Object.assign(new Error("accepted child"), { receipt: "child-receipt" })], "accepted"),
			{ receipt: "accepted" },
		),
	regexpLastIndex: () => Object.assign(/accepted/g, { receipt: "accepted", lastIndex: 7 }),
	symbolError: () => Object.assign(new Error("accepted"), { receipt: "accepted", [symbol]: { id: "symbol-receipt" } }),
	symbolRecord: () => ({ receipt: "accepted", [symbol]: { id: "symbol-receipt" } }),
	dateMetadata: () => Object.assign(new Date(123), { receipt: "accepted", completedStatus: "accepted" }),
	ordinary: () => ({ receipt: "accepted", nested: { id: "plain-receipt" } }),
};

// pi#141 / P2-AUDIT-NATIVE-FIDELITY-EXTENDED: admitted state survives successful hooks and rejected mutation.
for (const [kind, make] of Object.entries(variants)) {
	for (const mode of ["direct", "sequential", "parallel"] as const) {
		it.each([false, true])(`retains ${kind} state in ${mode} (rejecting mutation: %s)`, async (reject) => {
			const fact = make();
			const result: AgentToolResult<unknown> = {
				content: [{ type: "text", text: "accepted" }],
				details: { fact },
				usage,
			};
			let executions = 0;
			let hooks = 0;
			let workingFact: unknown;
			const tool: AgentTool = {
				name: "native",
				label: "Native",
				description: "Synthetic",
				parameters: Type.Object({}),
				execute: async () => {
					executions++;
					return result;
				},
			};
			const call = { type: "toolCall" as const, id: "native-state", name: "native", arguments: {} };
			const assistantMessage = fauxAssistantMessage([call], { stopReason: "toolUse" });
			const failure = new Error("synthetic hook rejection");
			const afterToolCall = async ({ result: working }: { result: AgentToolResult<unknown> }) => {
				hooks++;
				workingFact = (working.details as { fact: object }).fact;
				if (reject) {
					Object.assign(workingFact as object, {
						receipt: "changed",
						completedStatus: "changed",
						lastIndex: 99,
						[symbol]: { id: "changed" },
					});
					if (workingFact instanceof AggregateError) Object.assign(workingFact.errors[0], { receipt: "changed" });
					throw failure;
				}
				return undefined;
			};
			let retained: AgentToolResult<unknown> | ToolResultMessage | undefined;
			if (mode === "direct") {
				const outcome = await runToolCall(call, {
					tools: [tool],
					context: { messages: [], tools: [tool] },
					assistantMessage,
					afterToolCall,
				});
				expect(outcome.publicationFailure?.error).toBe(reject ? failure : undefined);
				expect(outcome.isError).toBe(reject);
				retained = reject ? outcome.completedResult : outcome.result;
			} else {
				const published: ToolResultMessage[] = [];
				const agent = new Agent({
					initialState: { model, tools: [tool] },
					toolExecution: mode,
					streamFn: () => {
						const stream = createAssistantMessageEventStream();
						stream.push({ type: "done", reason: "toolUse", message: assistantMessage });
						return stream;
					},
				});
				agent.finishTurn = async () => ({ action: "end" });
				agent.afterToolCall = afterToolCall;
				agent.subscribe((event) => {
					if (event.type === "message_end" && event.message.role === "toolResult") published.push(event.message);
				});
				await agent.prompt("synthetic");
				expect(published).toHaveLength(1);
				expect(published[0].isError).toBe(false);
				retained = published[0];
			}
			expect(executions).toBe(1);
			expect(hooks).toBe(1);
			expect(workingFact).not.toBe(fact);
			expect(retained?.usage).toEqual(usage);
			const actual = (retained?.details as { fact: typeof fact }).fact;
			expect(actual).not.toBe(fact);
			expect(Object.getOwnPropertyDescriptors(actual)).toMatchObject(Object.getOwnPropertyDescriptors(fact));
			if (fact instanceof Date) {
				expect(actual).toBeInstanceOf(Date);
				expect((actual as Date).getTime()).toBe(123);
			}
			if (fact instanceof RegExp) {
				expect(actual).toBeInstanceOf(RegExp);
				expect((actual as RegExp).lastIndex).toBe(7);
			}
			if (fact instanceof AggregateError) {
				expect(actual).toBeInstanceOf(AggregateError);
				expect((actual as AggregateError).errors).toEqual(fact.errors);
				expect((actual as AggregateError).errors[0].receipt).toBe("child-receipt");
				expect((actual as AggregateError).errors[0]).not.toBe(fact.errors[0]);
			}
			if (Object.hasOwn(fact, symbol)) {
				const receipt = (actual as Record<symbol, unknown>)[symbol];
				expect(receipt).toEqual({ id: "symbol-receipt" });
				expect(receipt).not.toBe((fact as Record<symbol, unknown>)[symbol]);
			}
		});
	}
}

// pi#141 / P2-AUDIT-SNAPSHOT-GETTER: auditor's accepted read-once getter reaches actual SessionManager JSONL.
for (const mode of ["sequential", "parallel"] as const) {
	it.each([false, true])(`journals a read-once receipt in ${mode} (hook: %s)`, async (withHook) => {
		let reads = 0;
		let hooks = 0;
		let executions = 0;
		const fact = Object.defineProperty({}, "receipt", {
			enumerable: true,
			get: () => {
				reads++;
				if (reads > 1) throw new Error("completed getter consumed more than once");
				return { id: "accepted" };
			},
		});
		const tool: AgentTool = {
			name: "native",
			label: "Native",
			description: "Synthetic",
			parameters: Type.Object({}),
			execute: async () => {
				executions++;
				return { content: [{ type: "text", text: "accepted" }], details: { fact }, usage };
			},
		};
		const call = { type: "toolCall" as const, id: "getter-receipt", name: "native", arguments: {} };
		const agent = new Agent({
			initialState: { model, tools: [tool] },
			toolExecution: mode,
			streamFn: () => {
				const stream = createAssistantMessageEventStream();
				stream.push({
					type: "done",
					reason: "toolUse",
					message: fauxAssistantMessage([call], { stopReason: "toolUse" }),
				});
				return stream;
			},
		});
		agent.finishTurn = async () => ({ action: "end" });
		if (withHook)
			agent.afterToolCall = async () => {
				hooks++;
				return undefined;
			};
		const directory = mkdtempSync(join(tmpdir(), "pi-r141-getter-"));
		const journal = SessionManager.create(directory, directory);
		agent.subscribe((event) => {
			if (
				event.type === "message_end" &&
				(event.message.role === "system" ||
					event.message.role === "user" ||
					event.message.role === "assistant" ||
					event.message.role === "toolResult")
			)
				journal.appendMessage(event.message);
		});
		await agent.prompt("synthetic");
		const file = journal.getSessionFile();
		if (!file) throw new Error("Missing journal");
		const rows = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { message?: ToolResultMessage })
			.filter((row) => row.message?.role === "toolResult");
		expect(executions).toBe(1);
		expect(hooks).toBe(withHook ? 1 : 0);
		expect(reads).toBe(1);
		expect(rows).toHaveLength(1);
		expect(rows[0].message).toMatchObject({
			details: { fact: { receipt: { id: "accepted" } } },
			usage,
			isError: false,
		});
	});
}
