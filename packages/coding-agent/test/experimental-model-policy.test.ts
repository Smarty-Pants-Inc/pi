import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { Harness } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelPolicyError, ModelRuntime } from "../src/core/model-runtime.ts";
import { openDurable as openCoding } from "../src/experimental/durable/runtime.ts";
import { openDurable as openVacation } from "../src/experimental/vacation/runtime.ts";

const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 1 }] };

// smarty-dev#12939 SEC-1: the session cwd, not the host process cwd, owns project policy.
describe("experimental Harness project model policy", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it.each([
		["durable", openCoding],
		["vacation", openVacation],
	])("binds %s model calls to target-project settings before provider dispatch", async (_name, open) => {
		const directory = mkdtempSync(join(tmpdir(), "pi-harness-model-policy-"));
		onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
		const agentDir = join(directory, "agent");
		const cwd = join(directory, "project");
		mkdirSync(agentDir);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ modelPolicy: { allow: ["faux/*"] } }));
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ modelPolicy: { allow: ["faux/gpt-6"] } }));
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		expect(cwd).not.toBe(process.cwd());

		const faux = fauxProvider({ models: [{ id: "gpt-5.5" }, { id: "gpt-6" }] });
		faux.setResponses([fauxAssistantMessage("allowed")]);
		const create = ModelRuntime.create.bind(ModelRuntime);
		vi.spyOn(ModelRuntime, "create").mockImplementation(async (options) => {
			const runtime = await create({
				...options,
				credentials: AuthStorage.inMemory(),
				modelsPath: null,
				modelsStore: new InMemoryModelsStore(),
				allowModelNetwork: false,
			});
			runtime.registerNativeProvider(faux.provider);
			await runtime.refresh({ allowNetwork: false });
			return runtime;
		});
		const opened = vi.spyOn(Harness, "open");
		const session = await open({ cwd });
		onTestFinished(() => session.close());
		const models = opened.mock.calls[0]![1].models;
		expect(models).toBeInstanceOf(ModelRuntime);
		const denied = models.getModel("faux", "gpt-5.5")!;
		const allowed = models.getModel("faux", "gpt-6")!;
		const fetch = vi.fn(() => Promise.reject(new Error("must not fetch")));
		expect(session.settings.isModelAllowed(denied)).toBe(false);
		expect(() => models.streamSimple(denied, context, { fetch })).toThrow(ModelPolicyError);
		expect(faux.state.callCount).toBe(0);
		expect(fetch).not.toHaveBeenCalled();
		expect((await models.completeSimple(allowed, context)).stopReason).toBe("stop");
		expect(faux.state.callCount).toBe(1);

		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ modelPolicy: { allow: [] } }));
		await session.settings.reload();
		expect(() => models.streamSimple(allowed, context, { fetch })).toThrow(ModelPolicyError);
		expect(faux.state.callCount).toBe(1);
		expect(fetch).not.toHaveBeenCalled();
	});
});
