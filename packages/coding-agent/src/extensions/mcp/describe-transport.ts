import type { McpServerEntry } from "./config.ts";

/** Ordinary transport details must not expose URL userinfo. Does not change the connection URL. */
export function describeTransport(entry: McpServerEntry): string {
	const { config } = entry;
	if (!("url" in config)) return [config.command, ...(config.args ?? [])].join(" ");
	const url = new URL(config.url);
	if (url.username === "" && url.password === "") return config.url;
	if (url.username !== "") url.username = "REDACTED";
	if (url.password !== "") url.password = "REDACTED";
	return url.href;
}
