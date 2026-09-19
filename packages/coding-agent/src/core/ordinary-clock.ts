import { performance } from "node:perf_hooks";

/** Original process clock object, available before child creation and shared by
 * bootstrap/accounting and Core. This is a source, NOT a qualified Stamp or
 * authority. External qualification must cover the original intake interval. */
export const ordinaryClock = Object.freeze({
	monotonic: () => performance.now(),
	wallTime: () => Date.now(),
	setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
	clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});
