/** pi#160: rejected installed trust roots warn; absent trust roots remain silent. */
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startHerdrInputConsumer } from "../src/core/herdr/bootstrap.ts";
import { checkServerTrustRoot } from "../src/core/herdr/server-auth.ts";

const env = { HERDR_SOCKET_PATH: "/nonexistent/herdr.sock", HERDR_PANE_ID: "w1:p1" };
let dir = "";
const restore: (() => void)[] = [];
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-herdr-trust-"));
	const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => unknown };
	const isTTY = Object.getOwnPropertyDescriptor(stdin, "isTTY");
	const setRawMode = Object.getOwnPropertyDescriptor(stdin, "setRawMode");
	Object.defineProperty(stdin, "isTTY", { value: true, configurable: true });
	Object.defineProperty(stdin, "setRawMode", { value: vi.fn(), configurable: true, writable: true });
	restore.push(() => {
		if (isTTY) Object.defineProperty(stdin, "isTTY", isTTY);
		else delete (stdin as { isTTY?: boolean }).isTTY;
		if (setRawMode) Object.defineProperty(stdin, "setRawMode", setRawMode);
		else delete (stdin as { setRawMode?: unknown }).setRawMode;
	});
});
afterEach(() => {
	for (const step of restore.splice(0)) step();
	rmSync(dir, { recursive: true, force: true });
});
describe.runIf(process.platform === "linux")("Herdr trust root at startup", () => {
	it("stays silent when no trust root is installed", async () => {
		const missing = join(dir, "server.pub");
		expect(checkServerTrustRoot(missing)).toBeUndefined();
		const bootstrap = await startHerdrInputConsumer(env, {
			hardened: () => true,
			trustRoot: () => checkServerTrustRoot(missing),
		});
		expect(bootstrap).toBeUndefined();
		expect(process.stdin.setRawMode).not.toHaveBeenCalled();
	});
	it("warns for a non-root-owned trust root without raw mode", async () => {
		const path = join(dir, "server.pub");
		writeFileSync(path, generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }));
		expect(checkServerTrustRoot(path)).toEqual({ rejected: "untrusted-trust-root" });
		const bootstrap = await startHerdrInputConsumer(env, {
			hardened: () => true,
			trustRoot: () => checkServerTrustRoot(path),
		});
		expect(bootstrap?.diagnostic).toEqual({
			type: "warning",
			message: "Herdr input attestation unavailable (untrusted-trust-root): typed turns are recorded as terminal.",
		});
		expect(bootstrap?.attestor).toBeUndefined();
		expect(process.stdin.setRawMode).not.toHaveBeenCalled();
		const typed = Buffer.from("hello");
		expect(bootstrap?.meter.push(typed)).toEqual({ preEpoch: typed, epoch: Buffer.alloc(0), epochStart: 0 });
	});
	it("reports the specific rejected-key check", async () => {
		const dangling = join(dir, "dangling.pub");
		symlinkSync(join(dir, "nowhere"), dangling);
		expect(checkServerTrustRoot(dangling)).toEqual({ rejected: "untrusted-trust-root" });
		const bootstrap = await startHerdrInputConsumer(env, {
			hardened: () => true,
			trustRoot: () => ({ rejected: "unparsable-trust-root" }),
		});
		expect(bootstrap?.diagnostic?.message).toContain("(unparsable-trust-root)");
	});
});
