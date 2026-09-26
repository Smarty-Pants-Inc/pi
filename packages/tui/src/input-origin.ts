/**
 * Input origin: who produced the input that reaches components.
 *
 * Herdr wraps input that another agent sends into a pane through its API in APC
 * origin frames:
 *   start: ESC _ herdr-origin;v=1;kind=api;id=<id>;sender=<s>[;pane=<p>][;session=<sid>] ST
 *   end:   ESC _ herdr-origin;end;id=<id> ST
 * ST is ESC \. Values are percent-encoded. Input between the frames is "herdr-api";
 * all other input is "keyboard". The author comes from the frame, never from the text.
 */

export type InputOrigin =
	| { kind: "keyboard" }
	| { kind: "herdr-api"; sender: string; pane?: string; session?: string; id?: string };

export const KEYBOARD_INPUT_ORIGIN: InputOrigin = Object.freeze({ kind: "keyboard" });

export const HERDR_ORIGIN_PREFIX = "\x1b_herdr-origin";

export type HerdrOriginFrame =
	| { type: "start"; origin: Extract<InputOrigin, { kind: "herdr-api" }> }
	| { type: "end"; id?: string };

function decodeValue(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/**
 * Parse a complete herdr-origin APC sequence. Returns undefined for anything else,
 * including unterminated or truncated frames.
 */
export function parseHerdrOriginFrame(data: string): HerdrOriginFrame | undefined {
	if (!data.startsWith(`${HERDR_ORIGIN_PREFIX};`)) return undefined;
	if (!data.endsWith("\x1b\\")) return undefined;
	const body = data.slice(HERDR_ORIGIN_PREFIX.length + 1, -2);

	const parts = body.split(";");
	const fields = new Map<string, string>();
	for (const part of parts) {
		const eq = part.indexOf("=");
		if (eq > 0) fields.set(part.slice(0, eq), decodeValue(part.slice(eq + 1)));
	}
	if (parts[0] === "end") return { type: "end", id: fields.get("id") };

	// Unknown `v` values are tolerated: the frame still marks API input with the fields we can read.
	const origin: Extract<InputOrigin, { kind: "herdr-api" }> = {
		kind: "herdr-api",
		sender: fields.get("sender") || "unknown",
	};
	for (const key of ["pane", "session", "id"] as const) {
		const value = fields.get(key);
		if (value !== undefined) origin[key] = value;
	}
	return { type: "start", origin };
}

/** True for any herdr-origin frame, or a flushed fragment of one, that must never reach components. */
export function isHerdrOriginSequence(data: string): boolean {
	return data.startsWith(HERDR_ORIGIN_PREFIX) || (data.length > 2 && HERDR_ORIGIN_PREFIX.startsWith(data));
}
