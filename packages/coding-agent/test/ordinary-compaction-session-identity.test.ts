import { spawnSync } from "node:child_process";
import { copyFileSync, createWriteStream, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, test, vi } from "vitest";
import { createOriginalCompactionSessionIdentity } from "../src/core/original-compaction-session-identity.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const accountingTypes = [
	"smarty-sense:count-reservation-v1",
	"smarty-sense:count-qualification-v1",
	"smarty-sense:provider-reservation-v1",
	"smarty-sense:provider-usage-v1",
];

function createManager(): { manager: SessionManager; userEntryId: string } {
	const manager = SessionManager.inMemory(process.cwd());
	const userEntryId = manager.appendMessage({ role: "user", content: "seed input", timestamp: Date.now() });
	manager.appendMessage(fauxAssistantMessage("seed reply"));
	return { manager, userEntryId };
}

// #11897: the original-compaction fence must reject supported context and branch changes without copying bodies.
describe("original compaction session identity", () => {
	test.each(accountingTypes)("allows accounting-only append %s", (customType) => {
		const { manager } = createManager();
		const identity = createOriginalCompactionSessionIdentity(manager);

		manager.appendCustomEntry(customType, { amount: 1 });

		expect(() => identity.check()).not.toThrow();
	});

	test("rejects a concurrent user append", async () => {
		const { manager } = createManager();
		const identity = createOriginalCompactionSessionIdentity(manager);
		await Promise.resolve().then(() =>
			manager.appendMessage({ role: "user", content: "concurrent user input", timestamp: Date.now() }),
		);

		expect(() => identity.check()).toThrow("OPS_COMPACTION_SESSION_CHANGED");
	});

	test("rejects a supported context edit append", () => {
		const { manager, userEntryId } = createManager();
		const identity = createOriginalCompactionSessionIdentity(manager);

		manager.appendContextEdit(userEntryId, { content: "edited context" });

		expect(() => identity.check()).toThrow("OPS_COMPACTION_SESSION_CHANGED");
	});

	test("rejects a leaf switch", () => {
		const { manager, userEntryId } = createManager();
		const identity = createOriginalCompactionSessionIdentity(manager);

		manager.branch(userEntryId);

		expect(() => identity.check()).toThrow("OPS_COMPACTION_SESSION_CHANGED");
	});

	test("rejects session replacement/reload", () => {
		const { manager } = createManager();
		const identity = createOriginalCompactionSessionIdentity(manager);

		manager.newSession();

		expect(() => identity.check()).toThrow("OPS_COMPACTION_SESSION_CHANGED");
	});

	test("rejects same-ID reload with changed payload and an accounting tail", () => {
		const scratch = mkdtempSync(join(tmpdir(), "pi-compaction-identity-"));
		try {
			const path = join(scratch, "session.jsonl");
			const header = {
				type: "session",
				version: 3,
				id: "same-session",
				timestamp: new Date(0).toISOString(),
				cwd: process.cwd(),
			};
			const userEntry = {
				type: "message",
				id: "user-entry",
				parentId: null,
				timestamp: new Date(1).toISOString(),
				message: { role: "user", content: "old payload", timestamp: 1 },
			};
			const assistantEntry = {
				type: "message",
				id: "assistant-entry",
				parentId: "user-entry",
				timestamp: new Date(2).toISOString(),
				message: fauxAssistantMessage("reply", { timestamp: 2 }),
			};
			const writeJournal = (entries: unknown[]) =>
				writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
			writeJournal([header, userEntry, assistantEntry]);
			const manager = SessionManager.open(path);
			const identity = createOriginalCompactionSessionIdentity(manager);
			writeJournal([
				header,
				{ ...userEntry, message: { ...userEntry.message, content: "changed payload" } },
				assistantEntry,
				{
					type: "custom",
					id: "accounting-tail",
					parentId: "assistant-entry",
					timestamp: new Date(3).toISOString(),
					customType: accountingTypes[0],
				},
			]);

			manager.setSessionFile(path);

			expect(manager.getBranchIdentity().entries.map((entry) => entry.id)).toEqual([
				"user-entry",
				"assistant-entry",
				"accounting-tail",
			]);
			expect(manager.buildSessionProjection().messages[0]).toMatchObject({
				role: "user",
				content: "changed payload",
			});
			expect(() => identity.check()).toThrow("OPS_COMPACTION_SESSION_CHANGED");
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	test("refreshes its baseline after Pi's own compaction append", () => {
		const { manager, userEntryId } = createManager();
		const identity = createOriginalCompactionSessionIdentity(manager);

		manager.appendCompaction("own compaction", userEntryId, 20);
		identity.afterAppend();
		expect(() => identity.check()).not.toThrow();

		manager.appendCustomEntry("smarty-sense:provider-usage-v1", { tokens: 1 });
		expect(() => identity.check()).not.toThrow();
		manager.appendMessage({ role: "user", content: "new user input", timestamp: Date.now() });
		expect(() => identity.check()).toThrow("OPS_COMPACTION_SESSION_CHANGED");
	});

	// #11897 / pi#242: real journal bytes and the historical fence, not simulated memory pressure.
	// Opt in because the 300 MiB journal and two bounded children are intentionally heavy.
	test.skipIf(process.env.PI_HEAVY_TESTS !== "1")(
		"heavy (default skipped; set PI_HEAVY_TESTS=1): survives a 300 MiB journal where the old full-branch identity exhausts a 1 GiB old-space cap",
		async () => {
			const scratch = mkdtempSync(join(tmpdir(), "pi-compaction-identity-heavy-"));
			try {
				const original = join(scratch, "original.jsonl");
				const fixedInput = join(scratch, "fixed.jsonl");
				const timestamp = new Date(0).toISOString();
				let writtenBytes = 0;
				function* journalLines(): Generator<string> {
					// Keep realistic Unicode text alongside large ASCII portions, as in
					// multilingual tool output.
					const body = `λ${"x".repeat(1024 * 1024 - 2)}`;
					const header = { type: "session", version: 3, id: "identity-heavy", timestamp, cwd: scratch };
					const headerLine = `${JSON.stringify(header)}\n`;
					writtenBytes += Buffer.byteLength(headerLine);
					yield headerLine;
					// History accumulated since the prior checkpoint is still hot when the
					// next compaction starts. Do not hide the regression by making it cold.
					const compactionLine = `${JSON.stringify({
						type: "compaction",
						id: "checkpoint",
						parentId: null,
						timestamp,
						summary: "Earlier multilingual history",
						firstKeptEntryId: "checkpoint",
						tokensBefore: 100_000_000,
					})}\n`;
					writtenBytes += Buffer.byteLength(compactionLine);
					yield compactionLine;
					let parentId: string | null = "checkpoint";
					for (let index = 0; index < 300; index++) {
						const id = `body-${index}`;
						const line = `${JSON.stringify({
							type: "message",
							id,
							parentId,
							timestamp,
							message: { role: "user", content: `${index}: ${body}`, timestamp: 0 },
						})}\n`;
						writtenBytes += Buffer.byteLength(line);
						yield line;
						parentId = id;
					}
					for (let index = 0; index < 100; index++) {
						const id = `tail-${index}`;
						const line = `${JSON.stringify({
							type: "custom",
							id,
							parentId,
							timestamp,
							customType: "fixture-tail",
						})}\n`;
						writtenBytes += Buffer.byteLength(line);
						yield line;
						parentId = id;
					}
				}
				await pipeline(Readable.from(journalLines()), createWriteStream(original, { flags: "wx" }));
				const size = statSync(original).size;
				expect(size).toBe(writtenBytes);
				expect(size).toBeGreaterThanOrEqual(300 * 1024 * 1024);
				expect(size).toBeLessThan(301 * 1024 * 1024);
				// Independent byte-identical files: the fixed child's real appends must not alter
				// the old child's initial input. No sparse allocation or giant parent-side string.
				copyFileSync(original, fixedInput);
				expect(statSync(fixedInput).size).toBe(size);
				const child = fileURLToPath(
					new URL("./fixtures/ordinary-compaction-session-identity-child.ts", import.meta.url),
				);
				for (const mode of ["fixed", "old"] as const) {
					const result = spawnSync(
						process.execPath,
						[
							"--max-old-space-size=1024",
							// Keep the young-generation allowance stable across Node 22 and 24.
							"--max-semi-space-size=16",
							"--experimental-strip-types",
							child,
							mode,
							mode === "fixed" ? fixedInput : original,
							String(size),
						],
						{ encoding: "utf8", timeout: 90_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 },
					);
					const evidence = JSON.stringify({
						mode,
						status: result.status,
						signal: result.signal,
						error: result.error?.message,
						stdout: result.stdout,
						stderr: result.stderr,
					});
					expect(result.error, evidence).toBeUndefined();
					expect(result.stdout, evidence).toContain(`IDENTITY_READY ${mode} ${size} 401\n`);
					if (mode === "fixed") {
						expect(result.status, evidence).toBe(0);
						expect(result.signal, evidence).toBeNull();
						expect(result.stdout, evidence).toContain("FIXED_ACCOUNTING_CHECKED\n");
						expect(result.stdout, evidence).toContain("FIXED_MUTATION_REJECTED\n");
						console.log(
							`Heavy child receipt: ${JSON.stringify({ mode, status: result.status, signal: result.signal })}`,
						);
					} else {
						expect(result.signal === "SIGABRT" || result.status === 134, evidence).toBe(true);
						console.log(
							`Heavy child receipt: ${JSON.stringify({ mode, status: result.status, signal: result.signal })}`,
						);
					}
				}
			} finally {
				rmSync(scratch, { recursive: true, force: true });
			}
		},
		240_000,
	);

	test("uses the production metadata path instead of getBranch's owned payload view", () => {
		const { manager } = createManager();
		const getBranch = vi.spyOn(manager, "getBranch").mockImplementation(() => {
			throw new Error("payload-copying branch view must not be used");
		});
		const identity = createOriginalCompactionSessionIdentity(manager);

		expect(() => identity.check()).not.toThrow();
		expect(getBranch).not.toHaveBeenCalled();
	});
});
