import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { OwnerHost } from "../../src/core/owner-effects.ts";
import * as ownerEffects from "../../src/core/owner-effects.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SessionOwnership } from "../../src/core/session-ownership.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "../model-runtime-test-utils.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";

// smarty-code#1681: real SDK/AgentSession events, supported pi.appendEntry, and
// native loaders. Only the owned probe's host/admission construction is isolated.
const [storage, boundary, directory, operation, selectedFile, addon] = process.argv.slice(2);
if (!directory || !boundary || !["plain", "owned"].includes(storage)) throw new Error("Invalid child arguments");
const reopening = operation === "reopen";
const reply = "A genuine faux-provider streamed reply with several text deltas.";
const prompt = "Keep this first user message across a crash.";
const markerData = { version: 1, turn: 1 };

// Keep a blocked writer alive until the parent's SIGKILL; no shutdown/abort
// handler can manufacture a completed or partial assistant entry.
process.on("message", () => {});
async function ready(extra: Record<string, unknown> = {}): Promise<void> {
	if (!process.send) throw new Error("IPC required");
	await new Promise<void>((resolve, reject) => {
		process.send!(
			{ type: "ready", file: manager.getSessionFile(), header: manager.getHeader(), ...extra },
			(error) => (error ? reject(error) : resolve()),
		);
	});
}
async function hold(): Promise<void> {
	await ready({ providerCalls: faux.state.callCount, deltaCount });
	await new Promise<void>(() => {});
}

let manager: SessionManager;
if (storage === "plain") {
	manager = reopening ? SessionManager.open(selectedFile) : SessionManager.create(directory, directory);
} else {
	const native = createRequire(import.meta.url)(addon) as {
		open(directory: string, name: string, existing: boolean): object;
	};
	const construct = Reflect.get(ownerEffects, "firstTurnStorageHost") as (
		native: object,
		directory: string,
	) => OwnerHost;
	const host = construct(native, directory);
	// Real ownership factories: create and createAllocated share #create,
	// including the initial header flush. No allocation/admission is claimed.
	const ownership = reopening
		? await SessionOwnership.open(host, selectedFile)
		: SessionOwnership.create(host, directory);
	manager = ownership.manager;
}

const faux = registerFauxProvider({ api: "first-turn-faux", tokenSize: { min: 1, max: 1 } });
const credentials = AuthStorage.inMemory();
await credentials.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
const registry = await createInMemoryModelRegistry(credentials);
registry.registerProvider(faux.getModel().provider, {
	api: faux.api,
	apiKey: "faux-key",
	baseUrl: faux.getModel().baseUrl,
	models: faux.models,
});
let deltaCount = 0;
let reconstructedMarkers = 0;
let marked = false;
const extensions = await createTestExtensionsResult(
	[
		(pi) => {
			pi.on("session_start", (_event, ctx) => {
				reconstructedMarkers = ctx.sessionManager
					.getBranch()
					.filter((entry) => entry.type === "custom" && entry.customType === "reply-began").length;
				marked = reconstructedMarkers > 0;
			});
			pi.on("message_start", async (event) => {
				if (boundary !== "pre-delta-entry" || event.message.role !== "assistant") return;
				pi.appendEntry("pre-delta", { version: 1 });
				await hold();
			});
			pi.on("message_update", async (event) => {
				if (event.assistantMessageEvent.type !== "text_delta" || !event.assistantMessageEvent.delta) return;
				deltaCount++;
				if (marked) return;
				marked = true;
				pi.appendEntry("reply-began", markerData);
				if (boundary === "first-delta") await hold();
			});
		},
	],
	directory,
);
const { session } = await createAgentSession({
	cwd: directory,
	agentDir: directory,
	sessionManager: manager,
	modelRuntime: getModelRuntime(registry),
	model: faux.getModel(),
	settingsManager: SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
		cacheWarming: "off",
	}),
	resourceLoader: createTestResourceLoader({ extensionsResult: extensions }),
	noTools: "all",
});
await session.bindExtensions({
	mode: "tui",
	onError: (error) => {
		throw new Error(error.error);
	},
});

if (reopening) {
	// Let startup handlers and queued work run; do not prompt/continue/re-send.
	await session.waitForIdle();
	await delay(50);
	await ready({
		entries: manager.getEntries(),
		context: manager.buildSessionContext().messages,
		messages: session.messages,
		providerCalls: faux.state.callCount,
		reconstructedMarkers,
		streaming: session.isStreaming,
	});
	session.dispose();
	faux.unregister();
	process.disconnect();
} else {
	faux.setResponses([
		async () => {
			if (boundary === "before-delta") await hold();
			return fauxAssistantMessage(reply);
		},
	]);
	await session.prompt(prompt);
	await ready({ providerCalls: faux.state.callCount, deltaCount });
	await new Promise<void>(() => {});
}
