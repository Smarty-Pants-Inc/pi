import { resolve } from "node:path";
import { expect, test } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { main } from "../src/main.ts";

// Refusal/parser checks only: none calls native receiving or starts the TUI.
test("owned mode is off by default and requires an explicit canonical profile path", () => {
	expect(parseArgs([]).ownerHostProfile).toBeUndefined();
	const profile = resolve("qualified-owner-profile.json");
	const parsed = parseArgs(["--owner-host-profile", profile]);
	expect(parsed.ownerHostProfile).toBe(profile);
	expect(parsed.diagnostics).toEqual([]);
	expect(parseArgs(["--", "--owner-host-profile", profile]).ownerHostProfile).toBeUndefined();
});

test.each([
	["--owner-host-profile"],
	["--owner-host-profile", "relative.json"],
	["--owner-host-profile", "/"],
	["--owner-host-profile", `${resolve("profile.json")}\u0000`],
	[`--owner-host-profile=${resolve("profile.json")}`],
	["--owner-host-profile", resolve("first.json"), "--owner-host-profile", resolve("second.json")],
])("malformed owned selectors refuse before ordinary bootstrap: %j", async (...args) => {
	expect(parseArgs(args).diagnostics.some((entry) => entry.type === "error")).toBe(true);
	await expect(main(args)).rejects.toThrow("OWNER_PROFILE_UNAVAILABLE");
});

test.each(["--print", "--offline", "--continue", "--help"])(
	"an owned selector cannot fall through to %s",
	async (flag) => {
		await expect(main(["--owner-host-profile", resolve("profile.json"), flag])).rejects.toThrow(
			"OWNER_ORDINARY_MODE_UNAVAILABLE",
		);
	},
);
