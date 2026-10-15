import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

const sourceResolverUrl = new URL("../src/experimental/source-resolver.ts", import.meta.url).href;
const fixture = fileURLToPath(new URL("./fixtures/remote-catalog-startup.ts", import.meta.url));
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface StartupReceipt {
	mode: string;
	requests: string[];
	model: { api: string; baseUrl: string; contextWindow: number };
	localContextWindow: number;
	errors: string[];
	offline: string | null;
}

async function start(mode: string, optIn: string | undefined): Promise<StartupReceipt> {
	const root = mkdtempSync(join(tmpdir(), "pi-catalog-startup-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	writeFileSync(
		join(agentDir, "auth.json"),
		JSON.stringify({ anthropic: { type: "api_key", key: "local-test-key" } }),
	);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark", enableInstallTelemetry: false }));
	// Do not inherit provider credentials or an offline default from the parent test runner.
	const child = spawn(process.execPath, ["--import", sourceResolverUrl, fixture, mode], {
		cwd: root,
		env: {
			PATH: process.env.PATH,
			HOME: root,
			TMPDIR: process.env.TMPDIR,
			[ENV_AGENT_DIR]: agentDir,
			PI_SKIP_VERSION_CHECK: "1",
			...(optIn === undefined ? {} : { PI_REMOTE_CATALOG: optIn }),
		},
		stdio: ["pipe", "pipe", "pipe"],
		timeout: 15_000,
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	await new Promise<void>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => {
			if (code === 0 && signal === null) resolve();
			else reject(new Error(`Startup failed (${code}, ${signal}): ${stderr}\n${stdout}`));
		});
	});
	const receipt = /CATALOG_STARTUP (.+)/.exec(stderr)?.[1];
	if (!receipt) throw new Error(`Missing startup receipt: ${stderr}\n${stdout}`);
	return JSON.parse(receipt) as StartupReceipt;
}

describe("remote catalog startup policy", () => {
	// pi#244: cover both actual startup entry points, not just the provider wrapper in isolation.
	it.each(["interactive", "rpc"])("does not fetch a remote catalog on %s startup without the opt-in", async (mode) => {
		const receipt = await start(mode, undefined);
		expect(receipt.mode).toBe(mode);
		expect(receipt.errors).toEqual([]);
		expect(receipt.requests).toEqual([]);
		expect(receipt.model.contextWindow).toBe(receipt.localContextWindow);
		expect(receipt.offline).toBeNull();
	});

	// pi#244: the opt-in reaches HTTP but cannot replace the local request route.
	it.each(["interactive", "rpc"])("fetches and strips remote routing on opted-in %s startup", async (mode) => {
		const receipt = await start(mode, "1");
		expect(receipt.errors).toEqual([]);
		expect(receipt.requests).toEqual([
			"https://pi.dev/api/models/providers/anthropic?types=chat%2Cimage%2Cclassifier",
		]);
		expect(receipt.model).toMatchObject({
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com",
			contextWindow: 12345,
		});
		expect(receipt.offline).toBeNull();
	});
});
