import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Context, createStaticFacetLoader, defineFacet, defineService } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { consumeInternalProcessRole } from "../../src/experimental/process.ts";
import { runSessionWorkerWithHarness } from "../../src/experimental/session-worker.ts";
import { KeyedProbe } from "./keyed-service.ts";

export const TerminalPublication = defineService<{
	hold(failDelivery: boolean, context: Context): Promise<void>;
	held(context: Context): Promise<{ status: "done" | "unanswered"; operationId: string }>;
	release(context: Context): Promise<void>;
}>("test.terminal-publication");

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const role = consumeInternalProcessRole();
	if (role !== "session-worker") throw new Error("Faux Session worker requires a session-worker invocation");
	void runSessionWorkerWithHarness(process.argv.slice(2), async (databasePath, options) => {
		if (options.provider !== "anthropic" || options.model !== "claude-sonnet-4-5") {
			throw new Error(`Unexpected faux worker model: ${options.provider}/${options.model}`);
		}
		const faux = fauxProvider();
		const answer = fauxAssistantMessage("deterministic remote answer", { timestamp: 20 });
		faux.setResponses([answer, answer]);
		const models = createModels();
		models.setProvider(faux.provider);
		const harness = await Harness.open(
			await openNodeSqliteStorage(databasePath),
			{ models, registry: createRegistry() },
			BACKGROUND_CONTEXT,
		);
		const model = faux.getModel();
		const conversation = await harness.root(BACKGROUND_CONTEXT, {
			agent: { cwd: options.metadata.cwd, model: { provider: model.provider, modelId: model.id } },
		});
		let gate: Promise<void> | undefined;
		let release = (): void => {};
		let failDelivery = false;
		let held: Promise<{ status: "done" | "unanswered"; operationId: string }> | undefined;
		let reportHeld = (_result: { status: "done" | "unanswered"; operationId: string }): void => {};
		const submission = harness.submission.bind(harness);
		// pi#11 / smarty-dev#3535: gate the real durable settlement receipt, not a fabricated run event.
		harness.submission = async (id, context) => {
			const opened = await submission(id, context);
			if (opened === undefined) return undefined;
			return {
				id: opened.id,
				status: opened.status.bind(opened),
				abort: opened.abort.bind(opened),
				async wait(context) {
					const result = await opened.wait(context);
					if (gate !== undefined) {
						reportHeld({ status: result.status, operationId: String(id) });
						await gate;
						if (failDelivery) throw new Error("settlement delivery failed");
					}
					return result;
				},
			};
		};
		const keyedProbeFacet = defineFacet({
			id: "@test/keyed-probe",
			setup(env) {
				env.provide(TerminalPublication, {
					async hold(fail) {
						if (gate !== undefined) throw new Error("Settlement publication is already held");
						failDelivery = fail;
						held = new Promise((resolve) => {
							reportHeld = resolve;
						});
						gate = new Promise((resolve) => {
							release = resolve;
						});
					},
					async held() {
						if (held === undefined) throw new Error("Settlement publication is not held");
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
		return { harness, conversation, facetLoader: createStaticFacetLoader([keyedProbeFacet]) };
	}).catch((error: unknown) => {
		console.error(error);
		process.exit(1);
	});
}

function abortError(signal: AbortSignal): Error {
	const reason: unknown = signal.reason;
	return reason instanceof Error ? reason : new DOMException("The operation was aborted", "AbortError");
}
