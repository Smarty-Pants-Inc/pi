import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderConfigSchemas } from "../scripts/generate-schemas.ts";
import { SETTINGS_DEFAULTS } from "../src/core/settings-defaults.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

const model = { provider: "provider", id: "family/model" };
const modelKey = "provider/family/model";
const defaults = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
	maxSummaryTokens: 8000,
	primaryTimeoutMs: 300000,
	fallbackTimeoutMs: 240000,
};

// Regression coverage for #8133.
describe("compaction model overrides", () => {
	it("uses defaults without compaction settings", () => {
		const manager = SettingsManager.inMemory();
		expect(manager.getCompactionSettings()).toEqual(defaults);
		expect(manager.getCompactionSettings(model)).toEqual(defaults);
	});

	it("resolves each field independently and keeps individual getters consistent", () => {
		const manager = SettingsManager.inMemory({
			compaction: {
				reserveTokens: 8192,
				keepRecentTokens: 10000,
				modelOverrides: { [modelKey]: { reserveTokens: 400000 } },
			},
		});
		expect(manager.getCompactionSettings(model)).toEqual({
			...defaults,
			reserveTokens: 400000,
			keepRecentTokens: 10000,
			maxSummaryTokens: 8000,
		});
		expect(manager.getCompactionReserveTokens(model)).toBe(400000);
		expect(manager.getCompactionKeepRecentTokens(model)).toBe(10000);
		expect(manager.getCompactionSettings()).toEqual({
			...defaults,
			reserveTokens: 8192,
			keepRecentTokens: 10000,
			maxSummaryTokens: 8000,
		});

		manager.applyOverrides({ compaction: { modelOverrides: { [modelKey]: { keepRecentTokens: 30000 } } } });
		expect(manager.getCompactionKeepRecentTokens(model)).toBe(30000);
		expect(manager.getCompactionReserveTokens(model)).toBe(400000);
	});

	// smarty-dev#17478: output limits must not change the reserve or follow model overrides.
	it("keeps the summary output allowance independent of model reserve overrides", () => {
		const manager = SettingsManager.inMemory({
			compaction: {
				reserveTokens: 400000,
				maxSummaryTokens: 2000,
				modelOverrides: { [modelKey]: { reserveTokens: 1 } },
			},
		});
		expect(manager.getCompactionSettings(model)).toEqual({
			...defaults,
			reserveTokens: 1,
			maxSummaryTokens: 2000,
		});
		expect(manager.getCompactionSettings().reserveTokens).toBe(400000);
		expect(manager.getCompactionSettings().maxSummaryTokens).toBe(2000);
	});

	it("falls back to built-in defaults for missing fields", () => {
		const manager = SettingsManager.inMemory({
			compaction: { modelOverrides: { [modelKey]: { keepRecentTokens: 1024 } } },
		});
		expect(manager.getCompactionSettings(model)).toEqual({ ...defaults, keepRecentTokens: 1024 });
	});

	it("matches exact provider/model IDs, including IDs containing slashes", () => {
		const manager = SettingsManager.inMemory({
			compaction: {
				modelOverrides: {
					[modelKey]: { reserveTokens: 400000 },
					"provider/*": { reserveTokens: 1 },
					"family/model": { reserveTokens: 2 },
				},
			},
		});
		expect(manager.getCompactionReserveTokens(model)).toBe(400000);
		for (const other of [
			{ provider: "other", id: model.id },
			{ provider: model.provider, id: "other" },
			{ provider: model.provider, id: "family/Model" },
		]) {
			expect(manager.getCompactionSettings(other)).toEqual(defaults);
		}
	});

	it("merges project model overrides per field before resolving fallbacks", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({
				compaction: {
					reserveTokens: 8192,
					modelOverrides: {
						[modelKey]: { reserveTokens: 400000, keepRecentTokens: 30000 },
						"provider/other": { keepRecentTokens: 4096 },
					},
				},
			}),
		);
		storage.withLock("project", () =>
			JSON.stringify({
				compaction: { reserveTokens: 1024, modelOverrides: { [modelKey]: { keepRecentTokens: 2000 } } },
			}),
		);
		const manager = SettingsManager.fromStorage(storage);
		expect(manager.getCompactionSettings(model)).toEqual({
			...defaults,
			reserveTokens: 400000,
			keepRecentTokens: 2000,
			maxSummaryTokens: 8000,
		});
		expect(manager.getCompactionSettings({ provider: "provider", id: "other" })).toEqual({
			...defaults,
			reserveTokens: 1024,
			keepRecentTokens: 4096,
			maxSummaryTokens: 8000,
		});
		await manager.reload();
		expect(manager.getCompactionKeepRecentTokens(model)).toBe(2000);
		manager.setProjectTrusted(false);
		expect(manager.getCompactionKeepRecentTokens(model)).toBe(30000);
	});

	it("keeps enabled global and preserves overrides when saving the toggle", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({
				compaction: { modelOverrides: { [modelKey]: { enabled: false, reserveTokens: 400000 } } },
			}),
		);
		const manager = SettingsManager.fromStorage(storage);
		expect(manager.getCompactionSettings(model).enabled).toBe(true);
		manager.setCompactionEnabled(false);
		await manager.flush();
		await manager.reload();
		expect(manager.getCompactionSettings(model)).toEqual({ ...defaults, enabled: false, reserveTokens: 400000 });
	});

	describe.each(["reserveTokens", "keepRecentTokens"] as const)("model override %s", (field) => {
		it.each([null, -1, 1.5, "400000", true, {}, [], Number.MAX_SAFE_INTEGER + 1])(
			"reports invalid token values: %j",
			(value) => {
				const storage = new InMemorySettingsStorage();
				storage.withLock("global", () =>
					JSON.stringify({
						compaction: { modelOverrides: { [modelKey]: { [field]: value } } },
					}),
				);
				const manager = SettingsManager.fromStorage(storage);
				expect(() => manager.getCompactionSettings(model)).toThrow(
					`Invalid compaction.modelOverrides["${modelKey}"].${field} setting: ${String(value)}. Expected a non-negative safe integer.`,
				);
				expect(manager.getCompactionSettings()).toEqual(defaults);
				expect(manager.getCompactionSettings({ provider: "other", id: model.id })).toEqual(defaults);
			},
		);

		it.each([Number.NaN, Infinity, -Infinity])("reports non-finite runtime values: %s", (value) => {
			const manager = SettingsManager.inMemory();
			manager.applyOverrides({ compaction: { modelOverrides: { [modelKey]: { [field]: value } } } });
			expect(() => manager.getCompactionSettings(model)).toThrow(
				`Invalid compaction.modelOverrides["${modelKey}"].${field} setting: ${String(value)}`,
			);
		});
	});

	describe.each(["reserveTokens", "keepRecentTokens"] as const)("ordinary compaction.%s", (field) => {
		it.each([null, -1, 1.5, "400000", true, {}, [], Number.MAX_SAFE_INTEGER + 1])(
			"reports invalid values even when a valid model override exists: %j",
			(value) => {
				const storage = new InMemorySettingsStorage();
				storage.withLock("global", () =>
					JSON.stringify({
						compaction: {
							[field]: value,
							modelOverrides: { [modelKey]: { [field]: 4096 } },
						},
					}),
				);
				const manager = SettingsManager.fromStorage(storage);
				const error = `Invalid compaction.${field} setting: ${String(value)}. Expected a non-negative safe integer.`;
				expect(() => manager.getCompactionSettings()).toThrow(error);
				expect(() => manager.getCompactionSettings(model)).toThrow(error);
			},
		);

		it.each([Number.NaN, Infinity, -Infinity])("reports non-finite runtime values: %s", (value) => {
			const manager = SettingsManager.inMemory();
			manager.applyOverrides({ compaction: { [field]: value } });
			expect(() => manager.getCompactionSettings()).toThrow(`Invalid compaction.${field} setting: ${String(value)}`);
		});
	});

	it.each([null, false, 42, "invalid", []])("reports malformed model entries: %j", (entry) => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ compaction: { modelOverrides: { [modelKey]: entry } } }));
		expect(() => SettingsManager.fromStorage(storage).getCompactionSettings(model)).toThrow(
			`Invalid compaction.modelOverrides["${modelKey}"] setting: ${String(entry)}. Expected an object.`,
		);
	});

	it("accepts zero in ordinary settings and model overrides", () => {
		const manager = SettingsManager.inMemory({
			compaction: { reserveTokens: 0, keepRecentTokens: 0 },
		});
		expect(manager.getCompactionSettings(model)).toEqual({
			...defaults,
			reserveTokens: 0,
			keepRecentTokens: 0,
		});
		manager.applyOverrides({
			compaction: {
				reserveTokens: 1000,
				keepRecentTokens: 1000,
				modelOverrides: { [modelKey]: { reserveTokens: 0, keepRecentTokens: 0 } },
			},
		});
		expect(manager.getCompactionSettings(model)).toEqual({
			...defaults,
			reserveTokens: 0,
			keepRecentTokens: 0,
		});
	});
});

// smarty-dev#17478: configured phase budgets cannot bypass the nine-minute ceiling.
describe("compaction phase settings", () => {
	it("shares central defaults with the generated settings schema", () => {
		const settings = SettingsManager.inMemory();
		expect(settings.getCompactionTimeouts()).toEqual({ primaryTimeoutMs: 300000, fallbackTimeoutMs: 240000 });
		expect(defaults.primaryTimeoutMs).toBe(SETTINGS_DEFAULTS.compaction.primaryTimeoutMs);
		expect(defaults.fallbackTimeoutMs).toBe(SETTINGS_DEFAULTS.compaction.fallbackTimeoutMs);
		expect(readFileSync(new URL("../schemas/settings.schema.json", import.meta.url), "utf8")).toBe(
			renderConfigSchemas().get("schemas/settings.schema.json"),
		);
	});

	it.each([
		{ primaryTimeoutMs: 280000, fallbackTimeoutMs: 260000 },
		{ primaryTimeoutMs: 1, fallbackTimeoutMs: 1 },
		{ primaryTimeoutMs: 539999, fallbackTimeoutMs: 1 },
	])("allows smaller budgets and reallocations: %j", (timeouts) => {
		const settings = SettingsManager.inMemory({ compaction: timeouts });
		expect(settings.getCompactionSettings(model)).toMatchObject(timeouts);
	});

	it.each([
		{ primaryTimeoutMs: 300001 },
		{ fallbackTimeoutMs: 240001 },
		{ primaryTimeoutMs: 300000, fallbackTimeoutMs: 300000 },
	])("rejects an effective sum above 540000ms: %j", (timeouts) => {
		expect(() => SettingsManager.inMemory({ compaction: timeouts }).getCompactionSettings()).toThrow("540000ms");
	});

	describe.each(["primaryTimeoutMs", "fallbackTimeoutMs"] as const)("%s", (field) => {
		it.each([null, 0, -1, 1.5, "300000", true, {}, [], Number.NaN, Infinity, -Infinity])(
			"rejects invalid runtime budgets: %s",
			(value) => {
				const settings = SettingsManager.inMemory();
				settings.applyOverrides({ compaction: { [field]: value } });
				expect(() => settings.getCompactionSettings()).toThrow(`compaction.${field}`);
			},
		);
	});
});
