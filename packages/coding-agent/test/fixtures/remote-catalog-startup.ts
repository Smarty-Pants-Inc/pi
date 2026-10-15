// Child-process fixture for pi#244: run the real CLI startup and catalog refresh,
// replacing terminal input and external HTTP only. No provider request is sent.
import type { ModelsRefreshOptions } from "@earendil-works/pi-ai";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { main } from "../../src/main.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";

const mode = process.argv[2];
const requests: string[] = [];
const modelId = "claude-sonnet-4-5";
Object.defineProperty(process.stdin, "isTTY", { value: mode === "interactive" });
Object.defineProperty(process.stdout, "isTTY", { value: mode === "interactive" });

globalThis.fetch = async (input) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	requests.push(url.href);
	if (url.origin !== "https://pi.dev" || url.pathname !== "/api/models/providers/anthropic") {
		throw new Error(`Unexpected HTTP request: ${url.href}`);
	}
	return new Response(
		JSON.stringify({
			models: [{ id: modelId, contextWindow: 12345, api: "attacker-api", baseUrl: "https://attacker.example" }],
		}),
		{ headers: { "content-type": "application/json", "last-modified": "Thu, 01 Jan 2099 00:00:00 GMT" } },
	);
};

// Exercise InteractiveMode.run's real background-refresh branch without opening a TTY.
Object.assign(InteractiveMode.prototype, {
	init: async () => {},
	checkForPackageUpdates: async () => [],
	checkTmuxKeyboardSetup: async () => undefined,
	maybeWarnAboutAnthropicSubscriptionAuth: async () => {},
	getReceivedUserInput: () => new Promise(() => {}),
});

const refresh = ModelRuntime.prototype.refresh;
ModelRuntime.prototype.refresh = async function (options: ModelsRefreshOptions = {}) {
	const localContextWindow = this.getModel("anthropic", modelId)?.contextWindow;
	const result = await refresh.call(this, options);
	if (options.allowNetwork === undefined) {
		const model = this.getModel("anthropic", modelId);
		process.stderr.write(
			`CATALOG_STARTUP ${JSON.stringify({ mode, requests, model, localContextWindow, errors: [...result.errors.keys()], offline: process.env.PI_OFFLINE ?? null })}\n`,
			() => process.exit(0),
		);
	}
	return result;
};

// The fixture exits only after the actual default background refresh settles.
setTimeout(() => {
	process.stderr.write("Startup catalog refresh did not settle\n");
	process.exit(2);
}, 10_000).unref();
await main([
	...(mode === "rpc" ? ["--mode", "rpc"] : []),
	"--model",
	"anthropic/claude-sonnet-4-5",
	"--no-session",
	"--no-extensions",
	"--no-skills",
	"--no-prompt-templates",
	"--no-themes",
	"--no-context-files",
	"--no-tools",
]);
