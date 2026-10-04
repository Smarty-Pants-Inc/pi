import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type { CompactionCompletionContext } from "../../src/core/extensions/types.ts";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode.ts";
import { createHarness } from "../suite/harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const kind = process.argv[2];
const raw = kind.startsWith("raw");
const multi = kind === "multi";
const failed = kind.startsWith("error");
const entered = deferred(),
	childEntered = deferred(),
	start = deferred(),
	finish = deferred();
let aJoined = false,
	bJoined = false,
	aFinished = false,
	bFinished = false;
let eofAt = 0;
const h = await createHarness({
	settings: { compaction: { keepRecentTokens: 1 } },
	extensionFactories: [
		(pi) => {
			pi.on("session_before_compact", ({ preparation: { firstKeptEntryId, tokensBefore } }) =>
				failed ? { cancel: true } : { compaction: { summary: "native-rpc-fx3", firstKeptEntryId, tokensBefore } },
			);
			pi.on("session_shutdown", () => {
				process.stderr.write(
					`${JSON.stringify({ phase: "shutdown", kind, aJoined, bJoined, aFinished, bFinished, afterEofMs: Date.now() - eofAt })}\n`,
				);
			});
		},
	],
});
const runtime = new AgentSessionRuntime(
	h.session,
	{
		cwd: h.tempDir,
		agentDir: h.tempDir,
		modelRuntime: h.session.modelRuntime,
		settingsManager: h.settingsManager,
		resourceLoader: h.session.resourceLoader,
		diagnostics: [],
	},
	async () => {
		throw new Error("Unexpected replacement");
	},
);
void runRpcMode(runtime);
await new Promise((resolve) => setTimeout(resolve, 30));
const ctx = h.session.extensionRunner.createContext();
h.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
await h.session.prompt("one");
await h.session.prompt("two");
const callback = async (_result: unknown, owned: CompactionCompletionContext) => {
	entered.resolve();
	if (multi) {
		const child = async (_value: unknown, childOwned: CompactionCompletionContext) => {
			childEntered.resolve();
			await start.promise;
			await childOwned.waitForIdle();
			bJoined = true;
			bFinished = true;
		};
		ctx.compact({ onComplete: child, onError: child });
		await start.promise;
	}
	await (raw
		? kind.endsWith("abort")
			? h.session.abort()
			: h.session.waitForIdle()
		: kind.endsWith("abort")
			? owned.abort()
			: owned.waitForIdle());
	aJoined = true;
	await finish.promise;
	aFinished = true;
};
ctx.compact(failed ? { onError: callback } : { onComplete: callback });
await entered.promise;
if (multi) {
	await childEntered.promise;
	start.resolve();
}
process.stdin.once("end", () => {
	eofAt = Date.now();
	if (!raw) setTimeout(() => finish.resolve(), 100);
});
process.stderr.write(`${JSON.stringify({ phase: "ready", ready: true, kind })}\n`);
