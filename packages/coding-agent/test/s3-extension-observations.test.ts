import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../src/core/sdk.ts", import.meta.url), "utf8");
// Extract only the two in-memory callback bodies: the SDK session fixture removes files.
// smarty-dev#5822 / T-C1; full session integration remains a hosted-CI gate (#4664).
function callbackBody(name: string): string {
	const declaration = source.indexOf(`const ${name}:`);
	const start = source.indexOf("=> {", declaration) + 3;
	const end = source.indexOf("\n\t};", start) + 3;
	if (declaration < 0 || start < 3 || end < 3) throw new Error("SDK callback body not found");
	return source.slice(start, end);
}
function createObserver(name: string, events: unknown[]) {
	const ref = {
		current: {
			hasHandlers: () => true,
			emit: async (event: unknown) => {
				await Promise.resolve();
				events.push(event);
			},
		},
	};
	const make = new Function(
		"extensionRunnerRef",
		"raceWithAbortSignal",
		"shutdownSignal",
		`return async (response, model) => { const data = response; ${callbackBody(name)} }`,
	);
	return make(ref, (promise: Promise<void>) => promise, undefined) as (...args: unknown[]) => Promise<void>;
}
describe("T-C1 SDK extension observations", () => {
	it.each([100, 200, 599, 99, 600, 200.5])("exposes only validated status %s", async (status) => {
		const events: unknown[] = [];
		await createObserver("handleProviderResponse", events)({ status, headers: { "x-synthetic": "synthetic" } });
		expect(events).toEqual([
			Number.isInteger(status) && status >= 100 && status <= 599
				? { type: "after_provider_response", status }
				: { type: "after_provider_response" },
		]);
	});
	it("ignores provider stream data and model and awaits each notification", async () => {
		const events: unknown[] = [];
		const observer = createObserver("handleProviderStreamEvent", events);
		await observer({ synthetic: "synthetic" }, { provider: "synthetic", api: "synthetic", id: "synthetic" });
		expect(events).toEqual([{ type: "provider_stream_event" }]);
	});
});
