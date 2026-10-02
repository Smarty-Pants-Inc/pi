// pi#95 R10: source-grant refusal diagnostics identify the installed extension, not URL credentials.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadExtensions } from "../../../src/core/extensions/loader.ts";
import {
	finalizeExtensionTurnProvenanceCaller,
	getExtensionTurnProvenanceCaller,
	resolveExtensionTurnProvenance,
} from "../../../src/core/turn-provenance.ts";

const directories: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

it.each(["voice", "fabric"] as const)(
	"redacts userinfo and token query from %s source-grant refusal",
	async (channel) => {
		const root = mkdtempSync(join(tmpdir(), "pi-95-refusal-"));
		directories.push(root);
		const path = join(root, "extension.ts");
		writeFileSync(path, "export default function() {}");
		const loaded = await loadExtensions([path], root);
		expect(loaded.errors).toEqual([]);
		const extension = loaded.extensions[0];
		const source =
			"git:https://credential-user:credential-password@example.invalid/voice.git?token=query-secret@main";
		extension.sourceInfo = { ...extension.sourceInfo, source, origin: "package", scope: "user", baseDir: root };
		finalizeExtensionTurnProvenanceCaller(extension);
		const caller = getExtensionTurnProvenanceCaller(extension);
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const claim =
			channel === "voice"
				? { channel, principal: { id: "paul" } }
				: { channel, sender: { id: "session:org", kind: "main", verified: "mesh" } };
		const trust = { voiceExtensions: [source], fabricExtensions: [source] };
		expect(resolveExtensionTurnProvenance(claim, caller, trust).channel).toBe("terminal");
		expect(resolveExtensionTurnProvenance(claim, caller, trust).channel).toBe("terminal");
		expect(stderr).toHaveBeenCalledTimes(1);
		const diagnostic = stderr.mock.calls.map(([text]) => String(text)).join("");
		expect(diagnostic).toContain("refused Git/npm source grant");
		expect(diagnostic).toContain(JSON.stringify(path));
		for (const secret of ["credential-user", "credential-password", "query-secret", "?token=", source]) {
			expect(diagnostic).not.toContain(secret);
		}
	},
);
