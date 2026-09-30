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
 *
 * The top-level `autoEnableCodemode` (default true) activates the codemode tool when a server
 * with `codemode` or `codemode-deferred` exposure connects. A project value overrides the global one.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { type McpExposure, type McpServerConfig, validateMcpServerConfig } from "../../core/mcp-servers.ts";
import { getConfigValueEnvVarName, isCommandConfigValue } from "../../core/resolve-config-value.ts";

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
	/** Activate the codemode tool when `codemode` or `codemode-deferred` servers connect. Default: true. */
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

// Only these setting/value pairs are known harmless. Unknown names or arbitrary values in
// supported credential channels remain candidates, rather than being guessed nonsecret.
const HARMLESS_ENV_VALUES = new Map<string, readonly string[]>([
	["NODE_ENV", ["development", "production", "test"]],
	["LOG_LEVEL", ["trace", "debug", "info", "warn", "error", "fatal", "silent"]],
	["NO_COLOR", ["0", "1", "true", "false"]],
	["FORCE_COLOR", ["0", "1", "2", "3", "true", "false"]],
]);
const HARMLESS_HEADER_VALUES = new Map<string, readonly string[]>([
	["accept", ["application/json", "text/event-stream", "application/json, text/event-stream"]],
	["content-type", ["application/json", "application/json; charset=utf-8"]],
]);

function getLiteralCredentialFields(config: unknown): string[] {
	if (!isRecord(config)) return [];
	const fields: [string, string][] = [];
	for (const [key, value] of Object.entries(isRecord(config.env) ? config.env : {})) {
		if (typeof value === "string" && !HARMLESS_ENV_VALUES.get(key)?.includes(value)) {
			fields.push([`env.${key}`, value]);
		}
	}
	for (const [header, value] of Object.entries(isRecord(config.headers) ? config.headers : {})) {
		if (typeof value !== "string") continue;
		const name = header.toLowerCase();
		if (HARMLESS_HEADER_VALUES.get(name)?.includes(value)) continue;
		fields.push([`headers.${header}`, value]);
	}
	if (isRecord(config.oauth) && typeof config.oauth.clientSecret === "string") {
		fields.push(["oauth.clientSecret", config.oauth.clientSecret]);
	}
	const literalFields = fields
		.filter(([field, value]) => {
			// A reference anywhere in a template does not exclude a literal credential elsewhere.
			// Keys, clientSecret and Cookie require a whole reference; do not parse mixed cookies.
			if (isCommandConfigValue(value) || getConfigValueEnvVarName(value) !== undefined) return false;
			// Authorization may also contain an HTTP auth-scheme token followed by a whole reference.
			const scheme = /^headers\.(authorization|proxy-authorization)$/i.test(field)
				? /^[A-Za-z0-9!#$%&'*+.^_`|~-]+[ \t]+/.exec(value)?.[0]
				: undefined;
			return scheme === undefined || getConfigValueEnvVarName(value.slice(scheme.length)) === undefined;
		})
		.map(([field]) => field);
	// URLs are passed through without config-value resolution: userinfo is always literal,
	// even when it looks like an environment or command reference. Do not infer query semantics.
	if (typeof config.url === "string" && URL.canParse(config.url)) {
		const url = new URL(config.url);
		if (url.username !== "") literalFields.push("url.username");
		if (url.password !== "") literalFields.push("url.password");
	}
	return literalFields;
}

/** Redacted advice only; literal project credentials remain supported in private files. Never resolve values here. */
export function getMcpProjectConfigWarnings(entry: McpServerEntry): string[] {
	if (entry.scope !== "project") return [];
	return getLiteralCredentialFields(entry.config).map(
		(field) =>
			`${entry.source}: warning: project MCP server "${entry.name}" has a literal credential in ${field}; use an environment variable reference or !command instead.`,
	);
}

function readConfigFile(
	path: string,
	scope: "global" | "project",
	state: McpConfigState,
	onWarning: (warning: string) => void,
): void {
	const { servers, errors } = state;
	if (!existsSync(path)) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
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
		const entry = { name, config, source: path, scope };
		for (const warning of getMcpProjectConfigWarnings(entry)) onWarning(warning);
		servers.set(name, entry);
	}
}

/**
 * Load global and (when trusted) project MCP configuration. Disabled servers are included with
 * `enabled: false`, so they can be enabled again.
 */
export function loadMcpConfig(options: {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
	/** Defaults to console.warn, including session startup. Warnings do not invalidate entries. */
	onWarning?: (warning: string) => void;
}): LoadedMcpConfig {
	const state: McpConfigState = { servers: new Map(), errors: [] };
	const onWarning = options.onWarning ?? ((warning: string) => console.warn(warning));
	readConfigFile(join(options.agentDir, "mcp.json"), "global", state, onWarning);
	if (options.projectTrusted)
		readConfigFile(join(options.cwd, CONFIG_DIR_NAME, "mcp.json"), "project", state, onWarning);
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
		const server = servers && Object.hasOwn(servers, name) ? servers[name] : undefined;
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
		const target = servers ?? {};
		replaced = Object.hasOwn(target, name);
		// Server names may be object prototype names; persist them as ordinary own entries.
		Object.defineProperty(target, name, { value: config, writable: true, enumerable: true, configurable: true });
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

/**
 * Read an `mcp.json` (an empty config when missing), let `edit` change its `mcpServers`, and write
 * it back with its indentation when `edit` returns true. Other content is kept.
 */
function editMcpServers(
	path: string,
	edit: (servers: Record<string, unknown> | undefined, parsed: Record<string, unknown>) => boolean,
): void {
	const text = existsSync(path) ? readFileSync(path, "utf8") : undefined;
	const parsed: unknown = text === undefined ? {} : JSON.parse(text);
	if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
		throw new Error(`${path}: expected an object with an "mcpServers" object`);
	}
	const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : undefined;
	if (!edit(servers, parsed)) return;
	if (text !== undefined && (statSync(path).mode & 0o077) !== 0) {
		for (const [name, config] of Object.entries(parsed.mcpServers ?? {})) {
			const fields = getLiteralCredentialFields(config);
			if (fields.length > 0) {
				throw new Error(
					`${path}: refusing to persist literal credentials for MCP server "${name}" in ${fields.join(", ")} because the file allows group/world access; use environment variable references or !command, or have the owner explicitly restrict the file to mode 0600.`,
				);
			}
		}
	}
	const indent = (text && /^([ \t]+)\S/m.exec(text)?.[1]) || "  ";
	// Private defaults apply only to new paths; safe managed existing modes are left untouched.
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	// Exclusive creation refuses a file that appeared after the missing-file read.
	writeFileSync(path, `${JSON.stringify(parsed, null, indent)}\n`, {
		mode: 0o600,
		flag: text === undefined ? "wx" : "w",
	});
}
