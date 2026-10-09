import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import type { BashExecutionMessage, CustomMessage } from "./messages.ts";
import type { SessionManager } from "./session-manager.ts";
import type { TurnReceipt } from "./turn-receipts.ts";
import type { UserMessageMetadata } from "./user-message-metadata.ts";

interface ReceivedAppenders {
	appendMessage(
		message: Message | CustomMessage | BashExecutionMessage,
		receipt?: TurnReceipt,
		metadata?: UserMessageMetadata,
	): string;
	appendCustomMessage(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: unknown,
		receipt?: TurnReceipt,
	): string;
}
const appenders = new WeakMap<SessionManager, ReceivedAppenders>();

/** Constructor-only registration; append bodies never dispatch through public methods. */
export function bindSessionTurnAppender(manager: SessionManager, actions: ReceivedAppenders): void {
	if (appenders.has(manager)) throw new Error("SESSION_TURN_APPENDER_ALREADY_BOUND");
	appenders.set(manager, actions);
}

export function appendReceivedMessage(
	manager: SessionManager,
	message: Message | CustomMessage | BashExecutionMessage,
	receipt?: TurnReceipt,
	metadata?: UserMessageMetadata,
): string {
	const actions = appenders.get(manager);
	if (!actions) throw new Error("SESSION_TURN_APPENDER_REQUIRED");
	return actions.appendMessage(message, receipt, metadata);
}

export function appendReceivedCustomMessage(
	manager: SessionManager,
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details?: unknown,
	receipt?: TurnReceipt,
): string {
	const actions = appenders.get(manager);
	if (!actions) throw new Error("SESSION_TURN_APPENDER_REQUIRED");
	return actions.appendCustomMessage(customType, content, display, details, receipt);
}
