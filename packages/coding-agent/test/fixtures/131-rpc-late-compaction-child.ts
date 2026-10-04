import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type { AgentSessionServices } from "../../src/core/agent-session-services.ts";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode.ts";
import { createHarness } from "../suite/harness.ts";

const report = (value: Record<string, unknown>) => process.stderr.write(`${JSON.stringify(value)}\n`);
const h = await createHarness({
	extensionFactories: [
		(pi) => {
			pi.on("user_bash", () => ({
				operations: {
					exec: async () => {
						report({ phase: "native-operation-held" });
						await new Promise((resolve) => setTimeout(resolve, 60000));
						return { exitCode: 0 };
					},
				},
			}));
		},
	],
});
function services(value: Awaited<ReturnType<typeof createHarness>>): AgentSessionServices {
	return {
		cwd: value.tempDir,
		agentDir: value.tempDir,
		modelRuntime: value.session.modelRuntime,
		settingsManager: value.settingsManager,
		resourceLoader: value.session.resourceLoader,
		diagnostics: [],
	};
}
const runtime = new AgentSessionRuntime(h.session, services(h), async ({ sessionManager }) => {
	const receiving = await createHarness({ sessionManager });
	return {
		session: receiving.session,
		extensionsResult: receiving.session.resourceLoader.getExtensions(),
		services: services(receiving),
		diagnostics: [],
	};
});
void runRpcMode(runtime);
await new Promise((resolve) => setTimeout(resolve, 50));
process.stdin.once("end", () => {
	const session = runtime.session;
	const ctx = session.extensionRunner.createContext();
	report({ phase: "eof", idle: session.isIdle, replaced: session !== h.session });
	setTimeout(() => {
		ctx.compact({
			customInstructions: "late compaction during native command drainage",
			onError: async (error) => {
				report({
					phase: "late-completion-entered",
					error: error.message,
					shutdownAborted: session.shutdownSignal.aborted,
					idle: session.isIdle,
				});
				// Deliberately no rescue: external idle includes this retained callback.
				await session.waitForIdle();
			},
		});
		report({ phase: "late-admission-accepted" });
	}, 150);
});
report({ phase: "ready" });
