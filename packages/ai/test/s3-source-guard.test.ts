// Mechanical source guard for smarty-dev#5822 C1 and C3 (S3 of #5443, acceptance ledger item 3).
// Read-only: it scans source text and writes nothing.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
		for (const file of ["ai/src/utils/retry.ts", "ai/src/utils/overflow.ts"]) {
			const text = source(file);
			expect(text).toContain("assistantRecovery(message)");
			expect(text).not.toMatch(/PATTERNS?\.(?:test|some)\(/);
			expect(text).not.toMatch(/\.test\(message\.errorMessage/);
		}
	});
});
