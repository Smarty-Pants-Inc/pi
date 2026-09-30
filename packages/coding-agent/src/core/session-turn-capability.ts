// Package-private harness persistence. Deliberately not re-exported by any public entry point.
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import type { BashExecutionMessage, CustomMessage } from "./messages.ts";
import type { SessionManager } from "./session-manager.ts";
import type { TurnProvenance } from "./turn-provenance.ts";

interface SessionTurnAppender {
	message(message: Message | CustomMessage | BashExecutionMessage, provenance?: TurnProvenance): string;
	custom<T>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
		provenance?: TurnProvenance,
	): string;
}
const appenders = new WeakMap<SessionManager, SessionTurnAppender>();

/** SessionManager installs captured private methods once, before exposing the manager. */
export function registerSessionTurnAppender(manager: SessionManager, appender: SessionTurnAppender): void {
	if (appenders.has(manager)) throw new Error("SESSION_TURN_APPENDER_ALREADY_REGISTERED");
	appenders.set(manager, Object.freeze(appender));
}

/** Host-only route: the caller must hold provenance from the harness receipt ledger. */
export function appendHarnessMessage(
	manager: SessionManager,
	message: Message | CustomMessage | BashExecutionMessage,
	provenance?: TurnProvenance,
): string {
	const appender = appenders.get(manager);
	if (!appender) throw new Error("SESSION_TURN_APPENDER_REQUIRED");
	return appender.message(message, provenance);
}

/** Host-only route for extension turns already admitted by the harness. */
export function appendHarnessCustomMessage<T>(
	manager: SessionManager,
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details?: T,
	provenance?: TurnProvenance,
): string {
	const appender = appenders.get(manager);
	if (!appender) throw new Error("SESSION_TURN_APPENDER_REQUIRED");
	return appender.custom(customType, content, display, details, provenance);
}
