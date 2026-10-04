import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createHarness } from "../harness.ts";

// PR #131 P2-21 / A10: [] replaces prior tools and remains an empty modifier baseline.
it("preserves a project empty replacement through the public SDK factory", async () => {
	const harness = await createHarness();
	let sdkSession: Awaited<ReturnType<typeof createAgentSession>> | undefined;
	try {
		const agentDir = join(harness.tempDir, "profile");
		mkdirSync(agentDir);
		mkdirSync(join(harness.tempDir, ".pi"));
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["read", "bash"] }));
		writeFileSync(join(harness.tempDir, ".pi", "settings.json"), JSON.stringify({ defaultTools: [] }));
		const settingsManager = SettingsManager.create(harness.tempDir, agentDir, { projectTrusted: true });
		expect(settingsManager.getDefaultTools()).toEqual([]);
		sdkSession = await createAgentSession({
			cwd: harness.tempDir,
			agentDir,
			model: harness.getModel(),
			settingsManager,
			sessionManager: SessionManager.inMemory(harness.tempDir),
		});
		expect(sdkSession.session.getActiveToolNames()).toEqual([]);
	} finally {
		sdkSession?.session.dispose();
		harness.cleanup();
	}
});

it("does not restore defaults when modifiers operate on explicit empty state", () => {
	const settings = SettingsManager.inMemory({ defaultTools: [] });
	settings.applyOverrides({ defaultTools: ["+read"] });
	expect(settings.getDefaultTools()).toEqual(["read"]);
	settings.applyOverrides({ defaultTools: ["-read"] });
	expect(settings.getDefaultTools()).toEqual([]);
	settings.applyOverrides({ defaultTools: ["+write"] });
	expect(settings.getDefaultTools()).toEqual(["write"]);
});
