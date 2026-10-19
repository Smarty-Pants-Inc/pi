// Mechanical source guard for smarty-dev#5822 C1 and C3 (S3 of #5443, acceptance ledger item 3).
// Read-only: source scans and owned-decision controls write nothing.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API } from "typescript/unstable/sync";
import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../src/types.ts";
import { isContextOverflow } from "../src/utils/overflow.ts";
import { classifyProviderFailure, isPrematureStreamError, isRetryableAssistantError } from "../src/utils/recovery.ts";

const packagesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [path] : [];
	});
}

const sources = ["ai", "agent", "coding-agent"].flatMap((pkg) =>
	sourceFiles(join(packagesDir, pkg, "src")).map((path) => ({
		file: relative(packagesDir, path),
		text: readFileSync(path, "utf8"),
	})),
);

/** Every call of `name` with the start of the first argument expression it passes. */
function calls(name: string): { file: string; argument: string }[] {
	const pattern = new RegExp(`\\b${name}(?:\\?\\.)?\\(\\s*([\\w$.]*)(\\(?)`, "g");
	return sources.flatMap(({ file, text }) =>
		[...text.matchAll(pattern)].map((match) => ({ file, argument: `${match[1]}${match[2]}` })),
	);
}

function source(file: string): string {
	const found = sources.find((entry) => entry.file === file);
	if (!found) throw new Error(`missing source ${file}`);
	return found.text;
}

const recorderName = "recordAssistantMessageStopDetails";
const allowedStopDetailsFields = new Set([
	"rawStopDetails",
	"stopDetailsState",
	"stopDetailsBytes",
	"stopDetailsSha256",
]);

/** TypeScript 7 parses through the compiler API; a virtual project keeps even synthetic inputs read-only. */
function parseSource(text: string): ts.SourceFile {
	const dir = join(packagesDir, "__s3_source_guard__");
	const file = join(dir, "source.ts");
	const config = join(dir, "tsconfig.json");
	const api = new API({
		fs: createVirtualFileSystem({
			[file]: text,
			[config]: JSON.stringify({
				compilerOptions: { noLib: true, noResolve: true, types: [] },
				files: ["source.ts"],
			}),
		}),
	});
	try {
		const snapshot = api.updateSnapshot({ openProjects: [config] });
		try {
			const program = snapshot.getProject(config)?.program;
			if (!program || program.getSyntacticDiagnostics(file).length) throw new Error("source did not parse");
			const ast = program.getSourceFile(file);
			if (!ast) throw new Error("missing parsed source");
			return ast;
		} finally {
			snapshot.dispose();
		}
	} finally {
		api.close();
	}
}

/** Fail closed: the message cannot escape, be aliased, or be used except as a direct, allowlisted write target. */
function recorderWrites(text: string): string[] {
	const ast = parseSource(text);
	const recorders = ast.statements.filter(
		(node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === recorderName,
	);
	if (recorders.length !== 1) throw new Error("expected one recorder declaration");
	const recorder = recorders[0];
	const parameter = recorder.parameters[0]?.name;
	if (!parameter || !ts.isIdentifier(parameter) || !recorder.body) throw new Error("missing message parameter/body");
	const messageName = parameter.text;
	const writes: string[] = [];
	function visit(node: ts.Node): void {
		if (node !== parameter && ts.isIdentifier(node) && node.text === messageName) {
			const access = node.parent;
			const field =
				ts.isPropertyAccessExpression(access) && access.expression === node
					? access.name.text
					: ts.isElementAccessExpression(access) &&
							access.expression === node &&
							ts.isStringLiteral(access.argumentExpression)
						? access.argumentExpression.text
						: undefined;
			if (!field || !allowedStopDetailsFields.has(field)) {
				throw new Error(`unapproved message target or escape: ${access.getText(ast)}`);
			}
			const operation = access.parent;
			const assignment =
				ts.isBinaryExpression(operation) &&
				operation.left === access &&
				operation.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
				operation.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
			const deletion = ts.isDeleteExpression(operation) && operation.expression === access;
			const update =
				(ts.isPrefixUnaryExpression(operation) || ts.isPostfixUnaryExpression(operation)) &&
				operation.operand === access &&
				(operation.operator === ts.SyntaxKind.PlusPlusToken ||
					operation.operator === ts.SyntaxKind.MinusMinusToken);
			if (!assignment && !deletion && !update) {
				throw new Error(`message use is not a direct write: ${operation.getText(ast)}`);
			}
			writes.push(field);
		}
		node.forEachChild(visit);
	}
	visit(recorder);
	return writes;
}

/** Check ancestry, not source order: a preceding refusal if does not protect a later call. */
function assertRefusalRecorderCall(text: string): void {
	const ast = parseSource(text);
	const invocations: ts.CallExpression[] = [];
	function visit(node: ts.Node): void {
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === recorderName) {
			invocations.push(node);
		}
		node.forEachChild(visit);
	}
	visit(ast);
	if (invocations.length !== 1) throw new Error("expected exactly one recorder invocation");
	const invocation = invocations[0];
	if (
		!invocation.arguments[0] ||
		!ts.isIdentifier(invocation.arguments[0]) ||
		invocation.arguments[0].text !== "failure"
	) {
		throw new Error("recorder must receive the terminal failure copy");
	}
	function unparenthesize(expression: ts.Expression): ts.Expression {
		return ts.isParenthesizedExpression(expression) ? unparenthesize(expression.expression) : expression;
	}
	for (let child: ts.Node = invocation; child.parent; child = child.parent) {
		const parent = child.parent;
		if (!ts.isIfStatement(parent) || parent.thenStatement !== child) continue;
		const condition = unparenthesize(parent.expression);
		if (!ts.isBinaryExpression(condition) || condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) {
			continue;
		}
		const left = unparenthesize(condition.left);
		const right = unparenthesize(condition.right);
		if (
			(ts.isIdentifier(left) &&
				left.text === "terminalStopReason" &&
				ts.isStringLiteral(right) &&
				right.text === "refusal") ||
			(ts.isIdentifier(right) &&
				right.text === "terminalStopReason" &&
				ts.isStringLiteral(left) &&
				left.text === "refusal")
		) {
			return;
		}
	}
	throw new Error("recorder invocation is not inside the refusal if-branch body");
}

/** Every record-field projection must be inside a then-branch that requires the failure phase. */
function assertFailureOnlyStopDetailsProjection(text: string): void {
	const ast = parseSource(text);
	const fields = new Set<string>();
	function requiresFailure(expression: ts.Expression): boolean {
		if (ts.isParenthesizedExpression(expression)) return requiresFailure(expression.expression);
		if (!ts.isBinaryExpression(expression)) return false;
		if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
			return requiresFailure(expression.left) || requiresFailure(expression.right);
		}
		return (
			expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
			ts.isIdentifier(expression.left) &&
			expression.left.text === "phase" &&
			ts.isStringLiteral(expression.right) &&
			expression.right.text === "failure"
		);
	}
	function visit(node: ts.Node): void {
		if (
			ts.isPropertyAccessExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === "projected" &&
			allowedStopDetailsFields.has(node.name.text)
		) {
			fields.add(node.name.text);
			let guarded = false;
			for (let child: ts.Node = node; child.parent; child = child.parent) {
				const parent = child.parent;
				if (ts.isIfStatement(parent) && parent.thenStatement === child && requiresFailure(parent.expression)) {
					guarded = true;
					break;
				}
			}
			if (!guarded) throw new Error("stop-details projection is not inside a failure-phase if-branch body");
		}
		node.forEachChild(visit);
	}
	visit(ast);
	if (fields.size !== allowedStopDetailsFields.size)
		throw new Error("expected all four stop-details projection fields");
}

// pi#297 / Smarty-Pants-Inc/smarty-dev#14961: prove that the boundary guard rejects its own bypasses.
describe("refusal stop_details AST guard self-tests", () => {
	const recorder = (extra: string) => `export async function ${recorderName}(message, details) {
		message.rawStopDetails = details;
		message.stopDetailsState ??= "retained";
		message.stopDetailsBytes = 1;
		delete message["stopDetailsSha256"];
		${extra}
	}`;

	it("enumerates all allowlisted writes, including computed deletes and updates", () => {
		expect(recorderWrites(recorder('message["stopDetailsBytes"] += 1; message.stopDetailsBytes++;'))).toEqual([
			"rawStopDetails",
			"stopDetailsState",
			"stopDetailsBytes",
			"stopDetailsSha256",
			"stopDetailsBytes",
			"stopDetailsBytes",
		]);
	});

	it.each([
		"message.other = details;",
		'message["other"] = details;',
		"message[field] = details;",
		"Object.assign(message, { other: details });",
		"message = { ...message, other: details };",
		"delete message.other;",
		'delete message["other"];',
		"helper(message);",
		"const alias = message; alias.other = details;",
		"message.rawStopDetails.other = details;",
		"Object.assign(message.rawStopDetails, { other: details });",
		"({ other: message.other } = details);",
	])("rejects a mutation or escape: %s", (mutation) => {
		expect(() => recorderWrites(recorder(mutation))).toThrow(
			/unapproved message target or escape|message use is not a direct write/,
		);
	});

	const projection = [...allowedStopDetailsFields].map((field) => `projected.${field} = message.${field};`).join("\n");
	it("accepts projections structurally gated by the failure phase", () => {
		expect(() =>
			assertFailureOnlyStopDetailsProjection(`if (phase === "failure" && refusal) { ${projection} }`),
		).not.toThrow();
	});
	it.each([
		`${projection}`,
		`if (phase === "failure") { prepare(); } ${projection}`,
		`if (phase === "failure") { prepare(); } else { ${projection} }`,
		`if (phase === "failure" || refusal) { ${projection} }`,
		`if (phase === "partial") { ${projection} }`,
		`// if (phase === "failure")\n${projection}`,
	])("rejects projections outside a required failure phase: %s", (text) => {
		expect(() => assertFailureOnlyStopDetailsProjection(text)).toThrow(/not inside a failure-phase if-branch body/);
	});

	const call = `${recorderName}(failure, details);`;
	it.each([
		`if (terminalStopReason === "refusal") { ${call} }`,
		`if (("refusal" === (terminalStopReason))) { if (ready) { ${call} } }`,
	])("accepts a sole invocation structurally in the refusal body: %s", (text) => {
		expect(() => assertRefusalRecorderCall(text)).not.toThrow();
	});

	it.each([
		`if (terminalStopReason === "refusal") { prepare(); } ${call}`,
		`if (terminalStopReason === "refusal") { prepare(); } else { ${call} }`,
		`if (terminalStopReason === "end_turn") { ${call} }`,
		`if (terminalStopReason === "refusal") { ${call} ${call} }`,
		`// if (terminalStopReason === "refusal")\n${call}`,
	])("rejects an unprotected or non-sole invocation: %s", (text) => {
		expect(() => assertRefusalRecorderCall(text)).toThrow(
			/expected exactly one recorder invocation|recorder invocation is not inside the refusal if-branch body/,
		);
	});
});

describe("smarty-dev#5822 source guard", () => {
	it("C1: every onResponse call passes only the validated status", () => {
		const found = calls("onResponse");
		expect(found.length).toBeGreaterThan(10);
		expect(found.filter(({ argument }) => argument !== "providerResponse(")).toEqual([]);
	});

	it("C1: every onProviderStreamEvent call passes only the owned notification", () => {
		const found = calls("onProviderStreamEvent");
		expect(found.length).toBeGreaterThan(2);
		expect(found.filter(({ argument }) => argument !== "providerStreamNotification(")).toEqual([]);
	});

	it("C1: public callback and extension types carry no raw event, header or model field", () => {
		const types = source("ai/src/types.ts");
		expect(types).toMatch(/export interface ProviderResponse \{\n\tstatus\?: number;\n\}/);
		expect(types).toContain("onResponse?: (response: ProviderResponse) => void | Promise<void>;");
		expect(types).toContain("onProviderStreamEvent?: (event: ProviderStreamNotification) => void | Promise<void>;");
		const extensionTypes = source("coding-agent/src/core/extensions/types.ts");
		expect(extensionTypes).toMatch(
			/export interface AfterProviderResponseEvent \{\n\ttype: "after_provider_response";\n\tstatus\?: number;\n\}/,
		);
		expect(extensionTypes).toMatch(/export interface ProviderStreamEvent \{\n\ttype: "provider_stream_event";\n\}/);
	});

	it("C1: response headers are converted only for request-side use", () => {
		const users = sources
			.filter(({ text }) => /\bheadersToRecord\(/.test(text))
			.map(({ file }) => file)
			.sort();
		// headers.ts defines it; Codex converts its own WebSocket request headers.
		expect(users).toEqual(["ai/src/api/openai-codex-responses.ts", "ai/src/utils/headers.ts"]);
	});

	it("C3: the stream classifies every error before masking, for every source", () => {
		const eventStream = source("ai/src/utils/event-stream.ts");
		const projector = eventStream.slice(eventStream.indexOf("function projectMessage("));
		expect(projector.slice(0, projector.indexOf("\n}"))).toContain("assistantRecovery(message)");
		const push = eventStream.slice(eventStream.indexOf("override push("));
		expect(push.indexOf("projectEvent(event)")).toBeGreaterThan(-1);
		expect(push.indexOf("projectEvent(event)")).toBeLessThan(push.indexOf("protectMessage("));
		const end = eventStream.slice(eventStream.indexOf("override end("));
		expect(end.indexOf("projectMessage(result")).toBeGreaterThan(-1);
		expect(end.indexOf("projectMessage(result")).toBeLessThan(end.indexOf("protectMessage("));
		expect(push).toContain("super.push(published)");
		expect(end).toContain("super.end(published)");
	});

	it("C3: no other assistant event stream bypasses the classifying stream", () => {
		const subclasses = sources
			.filter(({ text }) => /extends EventStream<AssistantMessageEvent\b/.test(text))
			.map(({ file }) => file)
			.sort();
		expect(subclasses).toEqual(["ai/src/utils/event-stream.ts"]);
	});

	it("N5682: no producer or projector forwards diagnostic details, errors or codes", () => {
		const diagnostics = source("ai/src/utils/diagnostics.ts");
		expect(diagnostics).not.toMatch(/\bdetails\??:/);
		expect(diagnostics).not.toMatch(/\bcode\??:/);
		expect(diagnostics).not.toContain("redactOAuthDiagnosticValue");
		for (const { file, text } of sources) {
			const literals = [...text.matchAll(/appendAssistantMessageDiagnostic\([^)]*\{/g)];
			expect({ file, literals: literals.length }).toEqual({ file, literals: 0 });
		}
		// pi#297 / Smarty-Pants-Inc/smarty-dev#14961: the one deliberate raw stop_details exception is pinned by
		// module name. It has exactly one exported writer, and that writer may mutate only the four record fields.
		const refusalStopDetailsFile = "ai/src/utils/refusal-stop-details.ts";
		const refusalStopDetails = source(refusalStopDetailsFile);
		expect(refusalStopDetails.match(/\bexport\b/g)).toHaveLength(1);
		expect(refusalStopDetails).toContain("export async function recordAssistantMessageStopDetails(");
		expect(new Set(recorderWrites(refusalStopDetails))).toEqual(allowedStopDetailsFields);

		const importers = sources
			.filter(({ file, text }) => file !== refusalStopDetailsFile && text.includes("refusal-stop-details.ts"))
			.map(({ file }) => file)
			.sort();
		expect(importers).toEqual(["ai/src/api/anthropic-messages.ts"]);
		const recorderCalls = calls("recordAssistantMessageStopDetails").filter(
			({ file }) => file !== refusalStopDetailsFile,
		);
		expect(recorderCalls).toEqual([{ file: "ai/src/api/anthropic-messages.ts", argument: "failure" }]);
		assertRefusalRecorderCall(source("ai/src/api/anthropic-messages.ts"));
		// pi#280: projection moved to assistant-message-snapshot.ts; this narrow terminal exception stays in scope
		// at the stream's shared push/end publication boundary, after the closed snapshot and before masking.
		assertFailureOnlyStopDetailsProjection(source("ai/src/utils/event-stream.ts"));

		expect(source("ai/src/utils/event-stream.ts")).not.toContain("redactOAuthDiagnosticValue");
	});

	it("P1-D: observer-failure wrappers keep no cause or thrown value (pi#202 round 2)", () => {
		for (const file of [
			"ai/src/utils/provider-observation.ts",
			"ai/src/api/pi-messages.ts",
			"ai/src/api/openai-codex-responses.ts",
		]) {
			const text = source(file);
			for (const match of text.matchAll(
				/new (?:Error\(PROVIDER_STREAM_OBSERVER_FAILED[^)]*\)|ProviderStreamEventCallbackError\([^)]*\))/g,
			)) {
				expect({ file, call: match[0] }).toEqual({
					file,
					call: match[0].startsWith("new Error")
						? "new Error(PROVIDER_STREAM_OBSERVER_FAILED)"
						: "new ProviderStreamEventCallbackError()",
				});
			}
		}
		const codex = source("ai/src/api/openai-codex-responses.ts");
		const callbackError = codex.slice(codex.indexOf("class ProviderStreamEventCallbackError"));
		expect(callbackError.slice(0, callbackError.indexOf("\n}"))).not.toContain("this.cause");
		expect(codex).toContain("stats.lastWebSocketError = webSocketErrorCategory(error);");
	});

	it("C3: retry, premature-stream and overflow checks read the owned decision, not raw text", () => {
		// pi#280: pure retry consumers moved to recovery.ts to preserve lean entry graphs.
		const recovery = source("ai/src/utils/recovery.ts");
		for (const name of ["isRetryableAssistantError", "isPrematureStreamError"]) {
			const start = recovery.indexOf(`export function ${name}(`);
			expect(start).toBeGreaterThan(-1);
			const body = recovery.slice(start, recovery.indexOf("\n}", start) + 2);
			expect(body).toContain("assistantRecovery(message)");
			expect(body).not.toMatch(/PATTERNS?\.(?:test|some)\(/);
			expect(body).not.toMatch(/\.test\(message\.errorMessage/);
		}
		const retry = source("ai/src/utils/retry.ts");
		expect(retry).toMatch(/import \{[^}]*\bisRetryableAssistantError,[^}]*\} from "\.\/recovery\.ts"/);
		expect(retry).toMatch(/export \{[^}]*\bisPrematureStreamError,[^}]*\} from "\.\/recovery\.ts"/);
		expect(retry).toContain("assistantRecovery(produced)");
		expect(retry).toContain("isRetryableAssistantError(response)");
		for (const file of ["ai/src/utils/retry.ts", "ai/src/utils/overflow.ts"]) {
			const text = source(file);
			if (file.endsWith("/overflow.ts")) expect(text).toContain("assistantRecovery(message)");
			expect(text).not.toMatch(/PATTERNS?\.(?:test|some)\(/);
			expect(text).not.toMatch(/\.test\(message\.errorMessage/);
		}
	});

	it("classifies bounded slow_down failures without overriding quota refusal (pi#280)", () => {
		expect(classifyProviderFailure({ text: "slow_down" })).toEqual({ recovery: "retryable", retryable: true });
		expect(classifyProviderFailure({ text: "provider: slow_down; retry" })).toEqual({
			recovery: "retryable",
			retryable: true,
		});
		for (const text of ["not_slow_down_suffix", "slow_down insufficient_quota", "slow_down billing"]) {
			expect(classifyProviderFailure({ text })).toEqual({ retryable: false });
		}
	});

	// pi#280, smarty-dev#5822: paired controls ensure the guard follows real owned decisions,
	// not merely a helper name or the presence of misleading public diagnostic text.
	it.each([
		["prompt is too long; 503; stream ended before message_stop", { retryable: false }, false, false, false],
		["Provider request failed", { recovery: "context_length_exceeded", retryable: false }, true, false, false],
		["Provider request failed", { recovery: "retryable", retryable: true }, false, true, false],
		["Provider request failed", { recovery: "premature_stream", retryable: true }, false, true, true],
		["prompt is too long", undefined, true, false, false],
		["invalid request", undefined, false, false, false],
		["slow_down", undefined, false, true, false],
		["slow_down", { retryable: false }, false, false, false],
		["slow_down insufficient_quota", undefined, false, false, false],
	] as const)(
		"C3: owned recovery overrides public text %s (%j)",
		(errorMessage, recovery, overflow, retry, premature) => {
			const message: AssistantMessage = {
				role: "assistant",
				api: "openai-completions",
				provider: "custom-5822",
				model: "test-model",
				content: [],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "error",
				errorMessage,
				recovery,
				timestamp: 0,
			};
			expect(isContextOverflow(message)).toBe(overflow);
			expect(isRetryableAssistantError(message)).toBe(retry);
			expect(isPrematureStreamError(message)).toBe(premature);
		},
	);
});
