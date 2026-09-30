import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatMcpLogMessage, McpServerLog } from "../src/extensions/mcp/log.ts";

// #2241: new MCP logs and rotation must be private without chmod of managed paths.
describe("private MCP logs", () => {
	let root: string;
	let previousUmask: number;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi92-private-log-"));
		previousUmask = process.umask(0o022);
	});
	afterEach(() => {
		process.umask(previousUmask);
		rmSync(root, { recursive: true, force: true });
	});

	it("creates every new directory at 0700 and the log at 0600", () => {
		const path = join(root, "new", "agent", "mcp.log");
		new McpServerLog(path).write("fake", { level: "warning", logger: "fixture", data: "fake line\ncontinued" });
		expect(statSync(join(root, "new")).mode & 0o777).toBe(0o700);
		expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readFileSync(path, "utf8")).toMatch(/\[fake\] warning fixture: fake line\n {4}continued\n$/);
	});

	it("rotates a private file and creates a private replacement", () => {
		const path = join(root, "new", "mcp.log");
		const log = new McpServerLog(path);
		log.write("fake", { data: "x".repeat(5 * 1024 * 1024 + 1) });
		log.write("fake", { data: "fake replacement" });
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(`${path}.1`).mode & 0o777).toBe(0o600);
		expect(statSync(`${path}.1`).size).toBeGreaterThan(5 * 1024 * 1024);
		expect(readFileSync(path, "utf8")).toContain("fake replacement");
	});

	it("preserves intentionally managed existing directory and file permissions", () => {
		const dir = join(root, "managed");
		mkdirSync(dir);
		chmodSync(dir, 0o750);
		const path = join(dir, "mcp.log");
		writeFileSync(path, "fake initial\n");
		chmodSync(path, 0o640);
		const first = new McpServerLog(path);
		const second = new McpServerLog(path);
		first.write("one", { data: "fake first" });
		second.write("two", { data: "fake second" });
		first.write("one", { data: "fake third" });
		expect(statSync(dir).mode & 0o777).toBe(0o750);
		expect(statSync(path).mode & 0o777).toBe(0o640);
		expect(readFileSync(path, "utf8")).toMatch(/fake initial\n.*fake first\n.*fake second\n.*fake third\n/s);
	});

	it("preserves managed permissions on rotation but creates the replacement privately", () => {
		const path = join(root, "mcp.log");
		writeFileSync(path, "x".repeat(5 * 1024 * 1024 + 1));
		chmodSync(path, 0o640);
		new McpServerLog(path).write("fake", { data: "fake replacement" });
		expect(statSync(`${path}.1`).mode & 0o777).toBe(0o640);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("cooperates when another writer has already rotated the log", () => {
		const path = join(root, "mcp.log");
		const first = new McpServerLog(path);
		first.write("one", { data: "x".repeat(5 * 1024 * 1024 + 1) });
		const second = new McpServerLog(path);
		second.write("two", { data: "fake rotated" });
		const rotatedSize = statSync(`${path}.1`).size;
		first.write("one", { data: "fake after rotation" });
		expect(statSync(`${path}.1`).size).toBe(rotatedSize);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readFileSync(path, "utf8")).toMatch(/fake rotated\n.*fake after rotation\n/s);
	});

	it("ignores failed writes and retries on the next notification", () => {
		const blocker = join(root, "blocked");
		writeFileSync(blocker, "fake blocker");
		const path = join(blocker, "mcp.log");
		const log = new McpServerLog(path);
		expect(() => log.write("fake", { data: "fake dropped" })).not.toThrow();
		expect(readFileSync(blocker, "utf8")).toBe("fake blocker");
		rmSync(blocker);
		log.write("fake", { data: "fake recovered" });
		expect(statSync(blocker).mode & 0o777).toBe(0o700);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readFileSync(path, "utf8")).toContain("fake recovered");
	});

	it("retains notification formatting", () => {
		expect(formatMcpLogMessage("fake", { level: "error", data: { fake: 7 } }, new Date("2026-01-01T00:00:00Z"))).toBe(
			'2026-01-01T00:00:00.000Z [fake] error {"fake":7}\n',
		);
	});
});
