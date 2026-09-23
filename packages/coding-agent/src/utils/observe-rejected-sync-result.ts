import { isPromise } from "node:util/types";

const originalThen = Promise.prototype.then;

/** Caller must first seal its synchronous refusal. Do not await, accept or retry
 * the forbidden result. Defer user-code access until that failure is established. */
export function observeRejectedSyncResult(value: unknown): void {
	void Promise.resolve()
		.then(() => {
			if (isPromise(value)) {
				// A native Promise can have a poisoned own `then`. Attach to its
				// internal state through the intrinsic, not through that property.
				void originalThen.call(
					value,
					() => {},
					() => {},
				);
				return;
			}
			// Non-native thenables still need assimilation/getter error containment.
			return value;
		})
		.catch(() => {});
}
