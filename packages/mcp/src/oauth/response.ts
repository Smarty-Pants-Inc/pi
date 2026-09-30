import type { McpFetch } from "../auth-provider.ts";
import { OAuthNetworkError, OAuthResponseLimitError } from "./errors.ts";

/** Received (decompressed) bytes, not Content-Length or decoded UTF-16 characters. */
export const MAX_OAUTH_RESPONSE_BYTES = 1024 * 1024;
export const MAX_OAUTH_DIAGNOSTIC_BYTES = 4096;
const DEFAULT_NETWORK_TIMEOUT_MS = 15_000;

export interface OAuthNetworkOptions {
	/** Cancellation of network work only; no deadline is imposed on browser/user interaction. */
	signal?: AbortSignal;
	/** Headers and body share this deadline; discovery candidates share one budget. Default: 15000. */
	networkTimeoutMs?: number;
	fetch?: McpFetch;
}

export interface OAuthNetworkOperation {
	fetch(input: string | URL, init?: RequestInit): Promise<Response>;
	text(response: Response): Promise<string>;
	discard(response: Response): void;
}

/** Each operation owns its abort listener/timer, including body reading and discovery fallback. */
export async function withOAuthNetwork<T>(
	options: OAuthNetworkOptions,
	run: (operation: OAuthNetworkOperation) => Promise<T>,
): Promise<T> {
	const timeout = options.networkTimeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS;
	if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2_147_483_647)
		throw new RangeError("OAuth networkTimeoutMs must be a positive finite timer duration");
	const controller = new AbortController();
	const signal = controller.signal;
	const onAbort = () =>
		controller.abort(new OAuthNetworkError("OAuth network operation cancelled", options.signal?.reason));
	options.signal?.addEventListener("abort", onAbort, { once: true });
	if (options.signal?.aborted) onAbort();
	const timer = setTimeout(
		() => controller.abort(new OAuthNetworkError(`OAuth network operation timed out after ${timeout}ms`)),
		timeout,
	);

	// The race also bounds injected fetch/read implementations that do not honor AbortSignal.
	const wait = async <V>(pending: Promise<V>): Promise<V> => {
		let abort: (() => void) | undefined;
		try {
			// Observe even a synchronously aborted injected fetch's later rejection.
			void pending.catch(() => {});
			signal.throwIfAborted();
			return await Promise.race([
				pending,
				new Promise<never>((_resolve, reject) => {
					abort = () => reject(signal.reason);
					signal.addEventListener("abort", abort, { once: true });
				}),
			]);
		} finally {
			if (abort) signal.removeEventListener("abort", abort);
		}
	};
	const discard = (response: Response) => {
		// Do not await cancellation: custom streams can make their cancel promise never settle.
		void response.body?.cancel().catch(() => {});
	};
	try {
		return await run({
			fetch: async (input, init) => {
				signal.throwIfAborted();
				const pending = (options.fetch ?? globalThis.fetch)(input, { ...init, signal });
				void pending.then(
					(response) => {
						if (signal.aborted) discard(response);
					},
					() => {},
				);
				return wait(pending);
			},
			discard,
			text: async (response) => {
				signal.throwIfAborted();
				if (!response.body) return "";
				const reader = response.body.getReader();
				// One bounded native allocation. No decoded text or retained chunks before the byte check.
				const bytes = new Uint8Array(MAX_OAUTH_RESPONSE_BYTES);
				let size = 0;
				const cancel = () => {
					void reader.cancel(signal.reason).catch(() => {});
				};
				signal.addEventListener("abort", cancel, { once: true });
				try {
					while (true) {
						signal.throwIfAborted();
						const { done, value } = await wait(reader.read());
						signal.throwIfAborted();
						if (done) return new TextDecoder().decode(bytes.subarray(0, size));
						const remaining = MAX_OAUTH_RESPONSE_BYTES - size;
						bytes.set(value.subarray(0, remaining), size);
						if (value.byteLength > remaining) {
							const prefix = new TextDecoder().decode(bytes.subarray(0, MAX_OAUTH_DIAGNOSTIC_BYTES), {
								stream: true,
							});
							throw new OAuthResponseLimitError(MAX_OAUTH_RESPONSE_BYTES, oauthDiagnostic(prefix));
						}
						size += value.byteLength;
					}
				} finally {
					signal.removeEventListener("abort", cancel);
					cancel();
					reader.releaseLock();
				}
			},
		});
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
		controller.abort();
	}
}

/** Bound error strings by UTF-8 bytes too, without a partial trailing code point. */
export function oauthDiagnostic(text: string): string {
	return new TextDecoder().decode(new TextEncoder().encode(text).subarray(0, MAX_OAUTH_DIAGNOSTIC_BYTES), {
		stream: true,
	});
}
