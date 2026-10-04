import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { radiusProvider } from "@earendil-works/pi-ai/providers/radius";
import { expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";

// smarty-dev#4703 F4: arbitrary terminal reason must not reach persisted session JSONL.
it("persists only an allowlisted Radius terminal error reason", async () => {
	const marker = "RADIUS_SESSION_REASON_4703_UNTRUSTED";
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("radius", async () => ({
		type: "oauth",
		access: "synthetic-access",
		refresh: "synthetic-refresh",
		expires: Date.now() + 3_600_000,
	}));
	const models = createModels({
		credentials,
		authContext: { env: async () => undefined, fileExists: async () => false },
	});
	const provider = radiusProvider();
	models.setProvider(provider);
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const output = await models.complete(
		provider.getModels()[0],
		{ messages: [] },
		{
			fetch: async () =>
				new Response(
					`data: ${JSON.stringify({ type: "error", reason: marker, usage, errorMessage: marker })}\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				),
		},
	);
	const directory = mkdtempSync(join(tmpdir(), "radius-terminal-reason-"));
	const session = SessionManager.create(directory, directory);
	session.appendMessage(output);
	const persisted = readFileSync(session.getSessionFile()!, "utf8");
	expect(output.stopReason).toBe("error");
	expect(persisted).toContain('"stopReason":"error"');
	expect(persisted).not.toContain(marker);
});
