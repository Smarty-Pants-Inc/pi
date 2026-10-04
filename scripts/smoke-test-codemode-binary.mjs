#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";

// Keep the historical filename: release staging still requires this gate.
const TOOL_MARKER = "PI_NATIVE_READ_OK";
const SUCCESS_MARKER = "PI_NATIVE_BINARY_SMOKE_OK";
const FAILURE_MARKER = "PI_NATIVE_BINARY_SMOKE_FAILED";
const TIMEOUT_MS = 30_000;

function completionChunk(id, delta, finishReason = null, usage) {
	return {
		id, object: "chat.completion.chunk", created: 0, model: "native-smoke",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
		...(usage ? { usage } : {}),
	};
}

function sendCompletion(response, chunks) {
	response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
	for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
	response.end("data: [DONE]\n\n");
}

async function snapshot(directory) {
	const files = [];
	const entries = await readdir(directory, { withFileTypes: true });
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push([entry.name, await snapshot(path)]);
		else if (entry.isFile()) files.push([entry.name, (await readFile(path)).toString("base64")]);
		else throw new Error(`Unexpected smoke artifact: ${path}`);
	}
	return JSON.stringify(files);
}

async function runBinary(binary, args, directory) {
	const javaScript = extname(binary) === ".js";
	const child = spawn(javaScript ? process.execPath : binary, javaScript ? [binary, ...args] : args, {
		cwd: directory,
		env: { ...process.env, PI_CODING_AGENT_DIR: directory, PI_OFFLINE: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
	child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
	let timedOut = false;
	const exitCode = await new Promise((resolveExit, reject) => {
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, TIMEOUT_MS);
		child.once("error", (error) => { clearTimeout(timer); reject(error); });
		// Wait for close, not just exit: drain output and join even a timed-out child.
		child.once("close", (code) => { clearTimeout(timer); resolveExit(code); });
	});
	if (timedOut) throw new Error(`Smoke test timed out after ${TIMEOUT_MS} ms\n${stdout}\n${stderr}`);
	return { exitCode, stdout, stderr };
}

async function main() {
	const binaryArg = process.argv[2];
	if (!binaryArg || process.argv.length !== 3) {
		throw new Error("Usage: node scripts/smoke-test-codemode-binary.mjs <pi-binary>");
	}
	const binary = resolve(binaryArg);
	const tempDir = await mkdtemp(join(tmpdir(), "pi-native-binary-smoke-"));
	let requestCount = 0;
	let toolResultSeen = false;
	let serverFailure;
	const server = createServer(async (request, response) => {
		requestCount++;
		try {
			if (request.method !== "POST" || !request.url?.endsWith("/chat/completions") || requestCount > 2) {
				throw new Error(`Unexpected smoke network request: ${request.method} ${request.url}`);
			}
			let body = "";
			for await (const chunk of request) body += chunk.toString();
			const payload = JSON.parse(body);
			const id = `chatcmpl-native-smoke-${requestCount}`;
			if (requestCount === 1) {
				const names = (payload.tools ?? []).map((tool) => tool.function?.name);
				if (!names.includes("read") || names.some((name) => name !== "read")) {
					throw new Error(`Expected only the native read tool, received ${JSON.stringify(names)}`);
				}
				sendCompletion(response, [
					completionChunk(id, { role: "assistant", tool_calls: [{ index: 0, id: "call_native_smoke", type: "function",
						function: { name: "read", arguments: JSON.stringify({ path: "native-marker.txt" }) } }] }),
					completionChunk(id, {}, "tool_calls", { prompt_tokens: 1, completion_tokens: 1 }),
				]);
				return;
			}
			toolResultSeen = Array.isArray(payload.messages) && payload.messages.some(
				(message) => message?.role === "tool" && JSON.stringify(message.content).includes(TOOL_MARKER),
			);
			sendCompletion(response, [
				completionChunk(id, { role: "assistant", content: toolResultSeen ? SUCCESS_MARKER : FAILURE_MARKER }),
				completionChunk(id, {}, "stop", { prompt_tokens: 1, completion_tokens: 1 }),
			]);
		} catch (error) {
			serverFailure = error;
			response.writeHead(500).end("Smoke protocol failure");
		}
	});

	try {
		await new Promise((resolveListen, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolveListen);
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Smoke-test server did not bind to a TCP port");
		const baseUrl = `http://127.0.0.1:${address.port}`;
		await writeFile(join(tempDir, "models.json"), JSON.stringify({ providers: { "native-smoke": {
			baseUrl: `${baseUrl}/v1`, api: "openai-completions", apiKey: "smoke-test",
			models: [{ id: "native-smoke" }],
		} } }));
		await writeFile(join(tempDir, "native-marker.txt"), TOOL_MARKER);
		// Neutral runtime stores avoid counting first-run initialization as a refused-feature effect.
		await writeFile(join(tempDir, "auth.json"), "{}", { mode: 0o600 });
		await writeFile(join(tempDir, "models-store.json"), "{}", { mode: 0o600 });
		await writeFile(join(tempDir, "settings.json"), JSON.stringify({ extensions: ["builtin:codemode", "builtin:mcp"] }));
		await writeFile(join(tempDir, "mcp.json"), JSON.stringify({ mcpServers: {
			http: { url: `${baseUrl}/mcp` },
			stdio: { command: "node", args: ["-e", "require('fs').writeFileSync('mcp-effect.txt', 'unexpected MCP process')"] },
		} }));
		const sessionArgs = [
			"--provider", "native-smoke", "--model", "native-smoke", "--print", "--no-session", "--offline",
			"--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-extensions",
		];
		// Explicit opt-in and stale settings cannot reopen the reviewed security cuts.
		for (const [args, marker] of [
			[[...sessionArgs, "--extension", "builtin:codemode", "--tools", "codemode", "Run a Codemode guest."], "CODEMODE_SECURITY_REVIEW_REQUIRED"],
			[[...sessionArgs, "--extension", "builtin:mcp", "Run MCP tools."], "MCP_SECURITY_REVIEW_REQUIRED"],
			[["mcp", "add", "smoke", "--url", `${baseUrl}/mcp`], "MCP_SECURITY_REVIEW_REQUIRED"],
		]) {
			const before = await snapshot(tempDir);
			const result = await runBinary(binary, args, tempDir);
			if (await snapshot(tempDir) !== before) throw new Error(`Refusal changed configuration or created a guest/process artifact: ${marker}`);
			if (result.exitCode === 0 || !`${result.stdout}\n${result.stderr}`.includes(marker) || requestCount !== 0) {
				throw new Error(`Expected effect-free rejection ${marker} (exit ${result.exitCode}, requests ${requestCount})\n${result.stdout}\n${result.stderr}`);
			}
		}
		const result = await runBinary(binary, [...sessionArgs, "--tools", "read", "Read native-marker.txt."], tempDir);
		if (serverFailure || result.exitCode !== 0 || !toolResultSeen || !result.stdout.includes(SUCCESS_MARKER) || requestCount !== 2) {
			throw new Error(`Native binary smoke test failed (exit ${result.exitCode}, requests ${requestCount})\n${serverFailure ?? ""}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
		}
		process.stdout.write(result.stdout);
	} finally {
		await new Promise((resolveClose) => server.close(resolveClose));
		// Retain diagnostics in the OS/runner-owned temporary directory; no recursive deletion.
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
