/**
 * MCP server configuration.
 *
 * Servers are read from `mcp.json` in the agent directory and, for trusted projects, from
 * `<project>/.pi/mcp.json`. Both use the `mcpServers` shape shared by other MCP clients, so
 * existing configurations can be copied over. Project entries replace global entries with the
 * same name.
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
 *     "docs": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } },
 *     "sentry": { "url": "https://mcp.sentry.dev/mcp" }
 *   }
 * }
 * ```
 *
 * HTTP servers without an `Authorization` header use OAuth when they answer 401 (sign in with `/mcp`).
 * `"auth": { "provider": "<provider>" }` sends the token of a `/login` provider instead. Project files
 * cannot use it, so a repository cannot pick where the credential goes.
 *
 * The top-level `autoEnableCodemode` (default true) activates the codemode tool when a server
 * with `codemode` exposure connects. A project value overrides the global one.
 */

import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import {
	type McpExposure,
	type McpServerConfig,
	mcpNamespace,
	validateMcpServerConfig,
} from "../../core/mcp-servers.ts";
import { getConfigValueEnvVarName } from "../../core/resolve-config-value.ts";

export type {
	McpExposure,
	McpHttpServerConfig,
	McpOAuthConfig,
	McpServerConfig,
	McpStdioServerConfig,
} from "../../core/mcp-servers.ts";
export { getMcpToolExposure } from "../../core/mcp-servers.ts";

export interface McpServerEntry {
	name: string;
	config: McpServerConfig;
	/** Config file that defined the entry, or the path of the extension that registered it. */
	source: string;
	/**
	 * The global or the project `mcp.json`, or `extension` for servers registered with
	 * `pi.registerMcpServer()`. Changes to extension servers are not saved.
	 */
	scope?: "global" | "project" | "extension";
}

export interface LoadedMcpConfig {
	servers: McpServerEntry[];
	/** Activate the codemode tool when `codemode` servers connect. Default: true. */
	autoEnableCodemode?: boolean;
	errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface McpConfigState {
	servers: Map<string, McpServerEntry>;
	autoEnableCodemode?: boolean;
	errors: string[];
}

function readConfigFile(path: string, scope: "global" | "project", state: McpConfigState): void {
	const { servers, errors } = state;
	if (!existsSync(path)) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		errors.push(`${path}: invalid MCP configuration JSON`);
		return;
	}
	if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
		errors.push(`${path}: expected an object with an "mcpServers" object`);
		return;
	}
	if (typeof parsed.autoEnableCodemode === "boolean") state.autoEnableCodemode = parsed.autoEnableCodemode;
	else if (parsed.autoEnableCodemode !== undefined) errors.push(`${path}: autoEnableCodemode must be a boolean`);
	for (const [name, value] of Object.entries(parsed.mcpServers ?? {})) {
		const config = validateMcpServerConfig(name, value);
		if (typeof config === "string") {
			errors.push(`${path}: ${config}`);
			continue;
		}
		// Names that differ only in `-` and `_` would share a namespace.
		const clash = [...servers.keys()].find((other) => other !== name && mcpNamespace(other) === mcpNamespace(name));
		if (clash) {
			errors.push(`${path}: server "${name}" conflicts with "${clash}"`);
			continue;
		}
		if (scope === "project" && "url" in config && config.auth) {
			errors.push(`${path}: server "${name}": auth is only allowed in the global mcp.json`);
			continue;
		}
		servers.set(name, { name, config, source: path, scope });
	}
}

/**
 * Load global and (when trusted) project MCP configuration. Disabled servers are included with
 * `enabled: false`, so they can be enabled again.
 */
export function loadMcpConfig(options: { agentDir: string; cwd: string; projectTrusted: boolean }): LoadedMcpConfig {
	const state: McpConfigState = { servers: new Map(), errors: [] };
	readConfigFile(join(options.agentDir, "mcp.json"), "global", state);
	if (options.projectTrusted) readConfigFile(join(options.cwd, CONFIG_DIR_NAME, "mcp.json"), "project", state);
	return {
		servers: [...state.servers.values()],
		...(state.autoEnableCodemode === undefined ? {} : { autoEnableCodemode: state.autoEnableCodemode }),
		errors: state.errors,
	};
}

/** Settings `/mcp` changes. `enabled: true` and `exposure: "codemode"` are the defaults and remove the key. */
export interface McpServerConfigPatch {
	enabled?: boolean;
	exposure?: McpExposure;
}

/**
 * Change one server's settings in the `mcp.json` that defines it. Other content is kept; the file is
 * rewritten with its indentation.
 */
export function updateMcpServerConfig(path: string, name: string, patch: McpServerConfigPatch): void {
	editMcpServers(path, (servers) => {
		const server = servers?.[name];
		if (!isRecord(server)) throw new Error(`${path} does not define MCP server "${name}"`);
		if (patch.enabled !== undefined) {
			if (patch.enabled) delete server.enabled;
			else server.enabled = false;
		}
		if (patch.exposure !== undefined) {
			if (patch.exposure === "codemode") delete server.exposure;
			else server.exposure = patch.exposure;
		}
		return true;
	});
}

/**
 * Add a server to an `mcp.json`, creating the file when missing. An existing entry with the same
 * name is replaced. Returns true when an entry was replaced.
 */
export function addMcpServerConfig(path: string, name: string, config: McpServerConfig): boolean {
	let replaced = false;
	editMcpServers(path, (servers, parsed) => {
		const target = servers ?? Object.create(null);
		replaced = Object.hasOwn(target, name);
		Object.defineProperty(target, name, { value: config, enumerable: true, configurable: true, writable: true });
		parsed.mcpServers = target;
		return true;
	});
	return replaced;
}

/** Remove a server from an `mcp.json`. Returns false when the file does not define it. */
export function removeMcpServerConfig(path: string, name: string): boolean {
	if (!existsSync(path)) return false;
	let removed = false;
	editMcpServers(path, (servers) => {
		if (!servers || !Object.hasOwn(servers, name)) return false;
		delete servers[name];
		removed = true;
		return true;
	});
	return removed;
}

/** Refusal to persist literal MCP credentials without a verified private destination. */
export class McpCredentialPersistenceError extends Error {
	constructor() {
		super(
			"MCP_LITERAL_CREDENTIAL_REFUSED: Cannot write literal MCP credentials to a non-private config file. Use an env-var reference or the private credential store.",
		);
		this.name = "McpCredentialPersistenceError";
	}
}

function hasLiteralMcpCredentials(document: unknown): boolean {
	if (!isRecord(document) || !isRecord(document.mcpServers)) return false;
	for (const server of Object.values(document.mcpServers)) {
		if (!isRecord(server)) continue;
		// Command/argv are opaque at the native receiver; do not certify unchecked strings nonsecret.
		if (
			typeof server.command === "string" &&
			((Array.isArray(server.args) && server.args.length > 0) || /[=\s]/.test(server.command))
		)
			return true;
		// Any custom header or child environment variable can carry credentials. Do not rely on
		// names, or exempt a literal merely because another part of the value references an env var.
		for (const field of ["headers", "env"] as const) {
			if (!isRecord(server[field])) continue;
			for (const value of Object.values(server[field])) {
				if (typeof value !== "string" || value === "") continue;
				const reference = field === "headers" ? value.replace(/^(?:Bearer|Basic)\s+/i, "") : value;
				if (getConfigValueEnvVarName(reference) === undefined) return true;
			}
		}
		if (
			isRecord(server.oauth) &&
			typeof server.oauth.clientSecret === "string" &&
			server.oauth.clientSecret !== "" &&
			getConfigValueEnvVarName(server.oauth.clientSecret) === undefined
		) {
			return true;
		}
		if (typeof server.url !== "string") continue;
		// URLs are not config-value templates at the transport receiver. Even reference-looking
		// userinfo and auth query values remain literal; malformed retained URLs fail closed too.
		if (!URL.canParse(server.url)) return true;
		const url = new URL(server.url);
		if (url.username || url.password) return true;
		for (const [name, value] of url.searchParams) {
			const key = name.toLowerCase().replace(/[^a-z0-9]/g, "");
			if (
				value !== "" &&
				(/token|secret|password|credential|signature|apikey|accesskey/.test(key) ||
					/^(?:x|proxy|http|client|api|oauth)?(?:key|auth|authorization|bearer|sig|passwd|pwd|jwt|session|sessionid|code)$/.test(
						key,
					))
			) {
				return true;
			}
		}
	}
	return false;
}

/** No creation, chmod, credential resolution, or migration: only an already-private file qualifies. */
function writePrivateMcpConfig(path: string, text: string): void {
	if (process.platform === "win32" || !process.getuid) throw new McpCredentialPersistenceError();
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
	} catch {
		throw new McpCredentialPersistenceError();
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.nlink !== 1) {
			throw new McpCredentialPersistenceError();
		}
		// Check the opened file, not a path stat followed by a second open that could name a
		// different, non-private destination. Refusal happens before truncation or any write.
		ftruncateSync(fd, 0);
		writeFileSync(fd, text);
	} finally {
		closeSync(fd);
	}
}

/**
 * Read an `mcp.json` (an empty config when missing), let `edit` change its `mcpServers`, and write
 * it back with its indentation when `edit` returns true. Other content is kept.
 */
function editMcpServers(
	path: string,
	edit: (servers: Record<string, unknown> | undefined, parsed: Record<string, unknown>) => boolean,
): void {
	const text = existsSync(path) ? readFileSync(path, "utf8") : undefined;
	let parsed: unknown;
	try {
		parsed = text === undefined ? {} : JSON.parse(text);
	} catch {
		throw new Error("Invalid MCP configuration JSON");
	}
	if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
		throw new Error(`${path}: expected an object with an "mcpServers" object`);
	}
	const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : undefined;
	if (!edit(servers, parsed)) return;
	const indent = (text && /^([ \t]+)\S/m.exec(text)?.[1]) || "  ";
	const candidate = `${JSON.stringify(parsed, null, indent)}\n`;
	// Inspect exactly the bytes to be persisted, including unchanged servers and toJSON output.
	if (hasLiteralMcpCredentials(JSON.parse(candidate))) {
		writePrivateMcpConfig(path, candidate);
		return;
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, candidate);
}
