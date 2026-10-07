import type { ImageContent } from "@earendil-works/pi-ai";
import { getInputReceipt, type ReceivedInput, receiveInput } from "./received-input.ts";

export interface ModeInputPlan {
	initial?: ReceivedInput;
	remaining: ReceivedInput[];
}

const plans = new WeakMap<object, ModeInputPlan>();

function receiveMessages(messages: readonly string[]): ReceivedInput[] {
	// One length read: a changing length must not allocate slots the loop never fills (pi#145 Astra r3).
	const length = messages.length;
	const inputs = new Array<ReceivedInput>(length);
	for (let index = 0; index < length; index++) {
		if (index in messages) inputs[index] = receiveInput(messages[index]);
	}
	return inputs;
}

/** Capture argv occurrences before setup, resource, and runtime awaits. */
export function captureCliInputPlan(target: object, messages: readonly string[], hasFileCandidate: boolean): void {
	const inputs = receiveMessages(messages);
	const hasInitial = hasFileCandidate || inputs.length > 0;
	plans.set(target, {
		initial: hasInitial ? (inputs.shift() ?? receiveInput("")) : undefined,
		remaining: inputs,
	});
}

/** Replace the initial placeholder with the assembled prompt while retaining its receipt. */
export function finalizeCliInputPlan(
	target: object,
	initialText: string | undefined,
	initialImages: ImageContent[] | undefined,
	stdinInput?: ReceivedInput,
): void {
	const plan = plans.get(target);
	if (!initialText) {
		plans.set(target, { remaining: plan?.remaining ?? [] });
		return;
	}

	const source = plan?.initial ?? stdinInput;
	const initial = source
		? receiveInput(initialText, initialImages, getInputReceipt(source))
		: receiveInput(initialText, initialImages);
	plans.set(target, { initial, remaining: plan?.remaining ?? [] });
}

/** Associate the private plan with a mode options object without changing its public shape. */
export function handoffModeInputPlan(source: object, target: object): void {
	const plan = plans.get(source);
	if (plan) {
		plans.delete(source);
		plans.set(target, plan);
	}
}

/** Take a plan once; direct mode callers get a fresh terminal fallback before startup awaits. */
export function takeModeInputPlan(
	target: object,
	initialText: string | undefined,
	initialImages: ImageContent[] | undefined,
	messages: readonly string[],
): ModeInputPlan {
	const existing = plans.get(target);
	if (existing) {
		plans.delete(target);
		return existing;
	}
	return {
		initial: initialText ? receiveInput(initialText, initialImages) : undefined,
		remaining: receiveMessages(messages),
	};
}
