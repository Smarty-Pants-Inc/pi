import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readSource = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
// smarty-dev#5822 / T-C1: direct imports must be safe without Models installing a wrapper.
describe("T-C1 mechanical callback inventory", () => {
	const eventAdapters = [
		"anthropic-messages",
		"bedrock-converse-stream",
		"google-generative-ai",
		"google-vertex",
		"mistral-conversations",
		"openai-codex-responses",
		"openai-completions",
		"openai-responses-shared",
		"pi-messages",
	];
	it.each(eventAdapters)("%s publishes only a notification", (adapter) => {
		const source = readSource(`../src/api/${adapter}.ts`);
		const calls = [...source.matchAll(/onProviderStreamEvent\?\.\(([^\n]*)/g)];
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) expect(call[1]).toBe('{ type: "provider_stream_event" });');
	});
	const responseAdapters = [
		"anthropic-messages",
		"azure-openai-responses",
		"bedrock-converse-stream",
		"llama-cpp-classify",
		"mistral-conversations",
		"openai-codex-responses",
		"openai-completions",
		"openai-responses",
		"openrouter-images",
		"pi-messages",
		"system-one-shared",
	];
	it.each(responseAdapters)("%s uses validated response observations", (adapter) => {
		const source = readSource(`../src/api/${adapter}.ts`);
		const calls = [...source.matchAll(/onResponse\?\.\(([^\n]*)/g)];
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			expect(call[1]).toMatch(/^providerResponseObservation\([\w.$]+\)\);$/);
		}
	});
	it("faux lifecycle observers publish status without a model argument", () => {
		const source = readSource("../src/providers/faux.ts");
		const calls = [...source.matchAll(/onResponse\?\.\(([^\n]*)/g)];
		expect(calls).toHaveLength(3);
		for (const call of calls) expect(call[1]).toBe("{ status: 200 });");
	});
	it("Bedrock deserialize callback publishes no raw response fields", () => {
		const source = readSource("../src/api/bedrock-converse-stream.ts");
		expect(source).toContain("return providerResponseObservation(response.statusCode);");
		expect(source).toContain("await onResponse(providerResponse);");
	});
});
// smarty-dev#5822 / R5 N1: guard the producer error branch and remove the proxy bypass.
describe("T-F6-error-kind mechanical guard", () => {
	it("has no done construction in the explicit producer-error branch", () => {
		const source = readSource("../src/utils/event-stream.ts");
		const start = source.indexOf('if (kind === "error")');
		expect(start).toBeGreaterThan(-1);
		const branch = source.slice(start, source.indexOf("switch (message.stopReason)", start));
		expect(branch).toContain('return { type: "error", reason, error };');
		expect(branch).not.toContain('type: "done"');
	});
	it("proxy constructs the shared stream, not another subclass", () => {
		const source = readSource("../../agent/src/proxy.ts");
		expect(source).toContain("const stream = createAssistantMessageEventStream();");
		expect(source).not.toContain("class ProxyMessageEventStream");
	});
});
