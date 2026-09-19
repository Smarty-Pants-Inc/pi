import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Context, createStaticFacetLoader, defineFacet, defineService } from "@earendil-works/chord";
import { AgentHarness, BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { consumeInternalProcessRole } from "../../src/experimental/process.ts";
import { runSessionWorkerWithHarness } from "../../src/experimental/session-worker.ts";
import { KeyedProbe } from "./keyed-service.ts";

type TerminalEvent = { type: "run_end" | "run_suspend"; runId: string };
export const TerminalPublication = defineService<{
	hold(deferred: boolean, context: Context): Promise<void>;
	held(context: Context): Promise<TerminalEvent>;
	release(context: Context): Promise<void>;
}>("test.terminal-publication");

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const role = consumeInternalProcessRole();
	if (role !== "session-worker") throw new Error("Faux Session worker requires a session-worker invocation");
	void runSessionWorkerWithHarness(process.argv.slice(2), async (session, options) => {
		if (options.provider !== "anthropic" || options.model !== "claude-sonnet-4-5") {
			throw new Error(`Unexpected faux worker model: ${options.provider}/${options.model}`);
		}
		const faux = fauxProvider();
		faux.setResponses([fauxAssistantMessage("deterministic remote answer", { timestamp: 20 })]);
		const models = createModels();
		models.setProvider(faux.provider);
		const harness = (
			await AgentHarness.create(
				{
					session,
					models,
					model: faux.getModel(),
					tools: [],
					resources: {},
				},
				BACKGROUND_CONTEXT,
			)
		).harness;
		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		let gate: Promise<void> | undefined;
		let release = (): void => {};
		let held: Promise<TerminalEvent> | undefined;
		let reportHeld = (_event: TerminalEvent): void => {};
		const watch = lane.watch.bind(lane);
		lane.watch = async (context) => {
			const opened = await watch(context);
			const start = opened.start.bind(opened);
			// PR #11: hold the real terminal event before Transcript publishes it,
			// without blocking the harness event bus or fabricating a lifecycle event.
			opened.start = (listener) =>
				start(async (event, context) => {
					if (gate !== undefined && (event.type === "run_end" || event.type === "run_suspend")) {
						reportHeld({ type: event.type, runId: event.runId });
						await gate;
					}
					await listener(event, context);
				});
			return opened;
		};
		const keyedProbeFacet = defineFacet({
			id: "@test/keyed-probe",
			setup(env) {
				env.provide(TerminalPublication, {
					async hold(deferred, context) {
						if (gate !== undefined) throw new Error("Terminal publication is already held");
						await harness.setStreamOptions({ deferred }, context);
						held = new Promise((resolve) => {
							reportHeld = resolve;
						});
						gate = new Promise((resolve) => {
							release = resolve;
						});
					},
					async held() {
						if (held === undefined) throw new Error("Terminal publication is not held");
						return held;
					},
					async release() {
						release();
						gate = undefined;
					},
				});
				const probes = env.provideMany(KeyedProbe);
				const spawn = (value: string): void => {
					const state = env.replicatedState({ value });
					let close = (): void => {};
					close = probes.spawn("probe", {
						state,
						async replace(next) {
							close();
							spawn(next);
						},
						async wait(context) {
							const signal = context.abortSignal;
							if (signal === undefined) throw new Error("Probe wait requires cancellation");
							if (signal.aborted) throw abortError(signal);
							await new Promise<void>((_resolve, reject) => {
								signal.addEventListener("abort", () => reject(abortError(signal)), { once: true });
							});
						},
					});
				};
				env.onActivate(() => spawn("first"));
			},
		});
		return { harness, lane, facetLoader: createStaticFacetLoader([keyedProbeFacet]) };
	}).catch((error: unknown) => {
		console.error(error);
		process.exit(1);
	});
}

function abortError(signal: AbortSignal): Error {
	const reason: unknown = signal.reason;
	return reason instanceof Error ? reason : new DOMException("The operation was aborted", "AbortError");
}
