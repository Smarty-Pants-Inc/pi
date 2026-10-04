/** Distinguishes a bounded body read failure from native header resolution failure. */
export class ResponseBodyError extends Error {}

/** Read before parsing, with a cumulative byte budget and cancellation of an active reader. */
export async function readBoundedResponse(
	response: Response,
	maxBytes: number,
	signal?: AbortSignal,
): Promise<Uint8Array> {
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	let cancellation: Promise<void> | undefined;
	const cancel = () => {
		cancellation ??= reader.cancel().catch(() => undefined);
	};
	signal?.addEventListener("abort", cancel, { once: true });
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		signal?.throwIfAborted();
		while (true) {
			const { done, value } = await reader.read();
			signal?.throwIfAborted();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) throw new ResponseBodyError("Response exceeds byte limit");
			chunks.push(value);
		}
		const body = new Uint8Array(bytes);
		let offset = 0;
		for (const chunk of chunks) {
			body.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return body;
	} catch (error) {
		cancel();
		if (signal?.aborted) throw signal.reason;
		throw error instanceof ResponseBodyError ? error : new ResponseBodyError("Response body read failed");
	} finally {
		signal?.removeEventListener("abort", cancel);
		await cancellation;
		reader.releaseLock();
	}
}

/** One deadline covers native headers and all body chunks, not just JSON parsing. */
export async function fetchBoundedResponse(
	input: string,
	init: RequestInit,
	maxBytes = 1024 * 1024,
	timeoutMs = 30_000,
	requestFetch: typeof fetch = globalThis.fetch,
): Promise<Response> {
	const controller = new AbortController();
	const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
	const timer = setTimeout(() => controller.abort(new Error("Response operation timed out")), timeoutMs);
	try {
		signal.throwIfAborted();
		const response = await requestFetch(input, { ...init, signal });
		const body = await readBoundedResponse(response, maxBytes, signal);
		return new Response(response.body ? body : null, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	} finally {
		clearTimeout(timer);
	}
}
