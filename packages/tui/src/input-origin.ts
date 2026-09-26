/**
 * Input origin: who produced the input that reaches components.
 *
 * Herdr wraps input that another agent sends into a pane through its API in origin frames:
 *   start: U+FDD0 herdr-origin;v=1;kind=api;id=<id>;sender=<s>[;pane=<p>][;session=<sid>] U+FDD1
 *   end:   U+FDD0 herdr-origin;end;id=<id> U+FDD1
 *   ready: U+FDD0 herdr-origin;ready;v=1 U+FDD1 (Herdr admitted this Pi's claim)
 * Values are percent-encoded. Input between the frames is "herdr-api". Other input is
 * "keyboard" only after the ready frame; before it, it is "unknown". The author comes from the
 * frame, never from the text.
 *
 * Herdr breaks U+FDD0 in all other input, so every U+FDD0 Pi reads starts a real frame. Stdin is
 * decoded as UTF-8, so U+FDD0 always arrives whole: however the rest of a frame is split or
 * delayed, Pi knows that a frame has started. Herdr sends frames only to a Pi that claims to
 * read them (see HERDR_INPUT_ORIGIN_CLAIM).
 */

export type InputOrigin =
	| { kind: "keyboard" }
	| { kind: "unknown" }
	| { kind: "herdr-api"; sender: string; pane?: string; session?: string; id?: string };

/** Typed input: unframed, after Herdr said that it frames API input (the ready frame). */
export const KEYBOARD_INPUT_ORIGIN: InputOrigin = Object.freeze({ kind: "keyboard" });

/**
 * Input whose author Pi cannot establish: unframed input before Herdr's ready frame (or with no
 * Herdr at all), and text that Pi restores or inserts itself (history, undo, kill ring, queued
 * messages, clipboard, external editor). Never recorded as keyboard.
 */
export const UNKNOWN_INPUT_ORIGIN: InputOrigin = Object.freeze({ kind: "unknown" });

const ORIGIN_RANK = { keyboard: 0, unknown: 1, "herdr-api": 2 } as const;

/** The origin of content with contributions from `a` and `b`: the least certain one wins. */
export function mergeInputOrigin(a: InputOrigin, b: InputOrigin): InputOrigin {
	return ORIGIN_RANK[b.kind] >= ORIGIN_RANK[a.kind] ? b : a;
}

/** Origin after a lost frame boundary: API input from an unknown sender, never keyboard. */
export const LOST_FRAME_INPUT_ORIGIN: InputOrigin = Object.freeze({ kind: "herdr-api", sender: "unknown" });

/** Starts every frame. */
export const HERDR_ORIGIN_MARKER = "\uFDD0";
/** Ends a frame header. */
export const HERDR_ORIGIN_HEADER_END = "\uFDD1";
const TAG = "herdr-origin;";

/**
 * Global that Herdr's Pi integration reads to tell Herdr that this process reads origin frames.
 * A global, not an environment variable, so child processes do not inherit the claim.
 */
export const HERDR_INPUT_ORIGIN_CLAIM = Symbol.for("pi.herdrInputOrigin");

/** Claim, for this process, that it reads Herdr origin frames. */
export function claimHerdrInputOrigin(): void {
	(globalThis as Record<symbol, unknown>)[HERDR_INPUT_ORIGIN_CLAIM] = "v1";
}

export type HerdrOriginFrame =
	| { type: "start"; origin: Extract<InputOrigin, { kind: "herdr-api" }> }
	| { type: "end"; id?: string }
	| { type: "ready" };

function decodeValue(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/** True for a frame, complete or not. It must never reach components. */
export function isHerdrOriginSequence(data: string): boolean {
	return data.startsWith(HERDR_ORIGIN_MARKER);
}

/** True for an end frame whose header did not complete. */
export function isIncompleteHerdrOriginEnd(data: string): boolean {
	return data.startsWith(`${HERDR_ORIGIN_MARKER}${TAG}end`);
}

/**
 * Parse a complete frame header. Returns undefined for anything else, including an unterminated
 * or truncated header.
 */
export function parseHerdrOriginFrame(data: string): HerdrOriginFrame | undefined {
	const prefix = `${HERDR_ORIGIN_MARKER}${TAG}`;
	if (!data.startsWith(prefix) || !data.endsWith(HERDR_ORIGIN_HEADER_END)) return undefined;
	const body = data.slice(prefix.length, -HERDR_ORIGIN_HEADER_END.length);
	if (body.includes(HERDR_ORIGIN_MARKER) || body.includes(HERDR_ORIGIN_HEADER_END)) return undefined;

	const parts = body.split(";");
	const fields = new Map<string, string>();
	for (const part of parts) {
		const eq = part.indexOf("=");
		if (eq > 0) fields.set(part.slice(0, eq), decodeValue(part.slice(eq + 1)));
	}
	if (parts[0] === "end") return { type: "end", id: fields.get("id") };
	if (parts[0] === "ready") return { type: "ready" };

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
