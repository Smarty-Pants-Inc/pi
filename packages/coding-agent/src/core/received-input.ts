import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession, PromptOptions } from "./agent-session.ts";
import type { InputSource } from "./extensions/types.ts";
import { captureTerminalTurnReceipt, receiptRecord, type TurnReceipt } from "./turn-receipts.ts";

/** Package-private input envelope. Receipt ownership is never an options/message field. */
export interface ReceivedInput {
	readonly text: string;
	readonly images?: ImageContent[];
}

const receipts = new WeakMap<ReceivedInput, TurnReceipt>();
interface ReceivedInputActions {
	prompt(input: ReceivedInput, options?: PromptOptions): Promise<void>;
	steer(input: ReceivedInput, source?: InputSource): Promise<void>;
	followUp(input: ReceivedInput, source?: InputSource): Promise<void>;
}
const sessions = new WeakMap<AgentSession, ReceivedInputActions>();

export function receiveInput(text: string, images?: ImageContent[], receipt?: TurnReceipt): ReceivedInput {
	const input = Object.freeze({ text, ...(images ? { images } : {}) });
	// Only issued handles return the same frozen record on repeated lookup. A forged
	// handle gets fresh fallback records, and cannot defer this envelope's admission.
	const record = receipt ? receiptRecord(receipt) : undefined;
	const owned = receipt && record === receiptRecord(receipt) ? receipt : captureTerminalTurnReceipt();
	receipts.set(input, owned);
	return input;
}

export function getInputReceipt(input: ReceivedInput): TurnReceipt {
	const receipt = receipts.get(input);
	if (!receipt) throw new Error("Input was not received by the harness");
	return receipt;
}

export function bindReceivedInputSession(session: AgentSession, actions: ReceivedInputActions): void {
	if (sessions.has(session)) throw new Error("Received input session is already bound");
	sessions.set(session, { prompt: actions.prompt, steer: actions.steer, followUp: actions.followUp });
}

export function promptReceived(session: AgentSession, input: ReceivedInput, options?: PromptOptions): Promise<void> {
	getInputReceipt(input);
	const actions = sessions.get(session);
	if (!actions) throw new Error("Received input session is not bound");
	return actions.prompt(input, options);
}

export function steerReceived(session: AgentSession, input: ReceivedInput, source?: InputSource): Promise<void> {
	getInputReceipt(input);
	const actions = sessions.get(session);
	if (!actions) throw new Error("Received input session is not bound");
	return actions.steer(input, source);
}

export function followUpReceived(session: AgentSession, input: ReceivedInput, source?: InputSource): Promise<void> {
	getInputReceipt(input);
	const actions = sessions.get(session);
	if (!actions) throw new Error("Received input session is not bound");
	return actions.followUp(input, source);
}
