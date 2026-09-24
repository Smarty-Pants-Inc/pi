import { spawn } from "node:child_process";
import { hostname } from "node:os";

/**
 * Pi's file links name this host and a line (`file://<host>/path#12`) for Herdr's link handlers. Local
 * openers such as gio and xdg-open may reject a host or fragment, so open this host's links as upstream's
 * plain `file:///path`. Other targets pass through unchanged.
 */
export function toLocalOpenTarget(target: string): string {
	if (!target.startsWith("file:")) return target;
	let url: URL;
	try {
		url = new URL(target);
	} catch {
		return target;
	}
	if (url.hostname.toLowerCase() !== hostname().toLowerCase()) return target;
	url.hostname = "";
	url.hash = "";
	return url.href;
}

/**
 * Open a URL or file in the platform browser/default handler.
 *
 * This intentionally never invokes a shell. On Windows, do not use
 * `cmd /c start`: cmd.exe re-parses metacharacters (&, |, ^, ...) before
 * `start` runs, which would make attacker-controlled URLs injectable.
 */
export function openBrowser(rawTarget: string): void {
	const target = toLocalOpenTarget(rawTarget);
	const [cmd, args]: [string, string[]] =
		process.platform === "darwin"
			? ["open", [target]]
			: process.platform === "win32"
				? ["rundll32", ["url.dll,FileProtocolHandler", target]]
				: ["xdg-open", [target]];

	// spawn reports launcher failures (for example, missing xdg-open) via an
	// error event. Browser launch is best-effort: callers still present the target
	// to the user, so keep the launcher failure from becoming a process crash.
	spawn(cmd, args, { stdio: "ignore", detached: true })
		.on("error", () => {})
		.unref();
}
