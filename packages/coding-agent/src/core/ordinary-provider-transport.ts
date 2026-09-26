import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { ClientRequest, IncomingMessage } from "node:http";
import { Agent, request as httpsRequest } from "node:https";
import { isIP, Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { connect as connectTls, type TLSSocket } from "node:tls";
import { observeResponsesEvidence, type ResponsesEvidence } from "@earendil-works/pi-ai/api/responses-evidence";
import { parseResponsesTokenCount } from "./ordinary-token-qualification.ts";

/** Private original-operation callbacks supplied only by OwnedOperation. */
export interface ProviderSocketCustody {
	connect(address: string, port: number, url: string, method: string): void;
	take(): number | null;
	retire(responseId: string, terminal: "completed" | "incomplete" | "failed" | "counted"): void;
}

export interface OwnedCountRequest {
	readonly binding: object;
	readonly requestId: string;
	readonly payloadHash: string;
	readonly countBodyHash: string;
}
export interface OwnedCountResult {
	readonly inputTokens: number;
}
const countResults = new WeakMap<OwnedCountResult, { binding: object; response: Response }>();

/** Data copies cannot substitute for this exchange's actually received response
 * and completed native socket retirement. The binding is the original plan. */
export function assertOwnedCountResult(result: OwnedCountResult, binding: object): void {
	if (countResults.get(result)?.binding !== binding) throw new Error("OWNER_COUNT_RESPONSE_SCOPE");
}

export interface OwnedProviderExchange {
	readonly response: Promise<Response>;
	/** Actual HTTP/parser/socket join, not an outer abort race. */
	readonly settled: Promise<void>;
	readonly countResult?: Promise<OwnedCountResult>;
}

/** One HTTPS request over the native operation's already-connected socket. No
 * pool, redirect, retry, proxy, ambient fetch, or second Responses parser. */
export function createOwnedProviderExchange(
	custody: ProviderSocketCustody,
	prepared: Request,
	wireModel: string,
	maxResponseBytes: number,
	beforeSend: (request: Request, bytes: Uint8Array) => Request,
	record: (evidence: Readonly<ResponsesEvidence>) => void,
	countRequest?: OwnedCountRequest,
): OwnedProviderExchange {
	// Retain the original plan and hashes before asynchronous transport work.
	const count = countRequest ? Object.freeze({ ...countRequest }) : undefined;
	let resolveHeaders!: (response: Response) => void;
	let rejectHeaders!: (error: unknown) => void;
	const response = new Promise<Response>((resolve, reject) => {
		resolveHeaders = resolve;
		rejectHeaders = reject;
	});
	let countResult: OwnedCountResult | undefined;
	const settled = (async () => {
		let tcp: Socket | undefined;
		let tls: TLSSocket | undefined;
		let request: ClientRequest | undefined;
		let incoming: IncomingMessage | undefined;
		const closes: Promise<void>[] = [];
		const agent = new Agent({ keepAlive: false, maxSockets: 1, maxTotalSockets: 1, maxCachedSessions: 0 });
		let evidence: Readonly<ResponsesEvidence> | undefined;
		let bodyComplete = false;
		let countResponse: Response | undefined;
		let inputTokens: number | undefined;
		const errors: unknown[] = [];
		let tlsReady!: () => void;
		const secure = new Promise<void>((resolve) => {
			tlsReady = resolve;
		});
		let parserDone!: () => void;
		const parser = new Promise<void>((resolve) => {
			parserDone = resolve;
		});
		let bodyDone!: () => void;
		let bodyFailed!: (error: unknown) => void;
		const body = new Promise<void>((resolve, reject) => {
			bodyDone = resolve;
			bodyFailed = reject;
		});
		// Observe failures immediately, including before the first HTTP headers.
		void body.catch(() => {});
		let interrupt!: (error: unknown) => void;
		const interrupted = new Promise<never>((_resolve, reject) => {
			interrupt = reject;
		});
		void interrupted.catch(() => {});
		const destroy = () => {
			incoming?.destroy();
			request?.destroy();
			tls?.destroy();
			tcp?.destroy();
			agent.destroy();
		};
		const fail = (error: unknown) => {
			if (!errors.length) errors.push(error);
			rejectHeaders(error);
			bodyFailed(error);
			interrupt(error);
			destroy();
		};
		const abort = () => fail(prepared.signal.reason);
		prepared.signal.addEventListener("abort", abort, { once: true });
		try {
			prepared.signal.throwIfAborted();
			// Node sends Expect headers during request construction, before our final guard.
			const initialHeaders = new Headers(prepared.headers);
			if (initialHeaders.has("expect")) throw new Error("OWNER_PROVIDER_EXPECT_HEADER");
			const url = new URL(prepared.url);
			if (url.protocol !== "https:" || url.username || url.password || url.hash || prepared.method !== "POST")
				throw new Error("OWNER_PROVIDER_ENDPOINT");
			const bytes = new Uint8Array(await prepared.arrayBuffer());
			if (count && createHash("sha256").update(bytes).digest("hex") !== count.countBodyHash)
				throw new Error("OWNER_COUNT_BODY_CHANGED");
			const hostname = url.hostname.replace(/^\[|\]$/g, "");
			// Lookup remains owned until it actually returns; an abort race cannot
			// report an unfinished native resolver operation as retired.
			const address = isIP(hostname) ? hostname : (await lookup(hostname)).address;
			prepared.signal.throwIfAborted();
			custody.connect(address, Number(url.port || 443), prepared.url, prepared.method);
			let fd = custody.take();
			while (fd === null) {
				await delay(5, undefined, { signal: prepared.signal });
				fd = custody.take();
			}
			tcp = new Socket({ fd, readable: true, writable: true });
			closes.push(new Promise<void>((resolve) => tcp!.once("close", () => resolve())));
			tcp.on("error", fail);
			prepared.signal.throwIfAborted();
			let created = false;
			agent.createConnection = () => {
				if (created || !tcp) throw new Error("OWNER_PROVIDER_SOCKET_REPLAY");
				created = true;
				// A local const keeps the narrowing under bun-types' node:tls declarations (smarty-dev#890).
				const secure = connectTls({
					socket: tcp,
					host: hostname,
					servername: isIP(hostname) ? undefined : hostname,
					rejectUnauthorized: true,
					ALPNProtocols: ["http/1.1"],
				});
				tls = secure;
				closes.push(new Promise<void>((resolve) => secure.once("close", () => resolve())));
				secure.on("error", fail);
				secure.once("secureConnect", tlsReady);
				return secure;
			};
			const headers = Object.fromEntries(initialHeaders);
			delete headers.host;
			delete headers["transfer-encoding"];
			headers["content-length"] = String(bytes.length);
			headers["accept-encoding"] = "identity";
			headers.connection = "close";
			prepared.signal.throwIfAborted();
			request = httpsRequest(url, { method: "POST", headers, agent, maxHeaderSize: 16_384 }, (message) => {
				incoming = message;
				closes.push(new Promise<void>((resolve) => message.once("close", () => resolve())));
				message.on("error", fail);
				try {
					const status = message.statusCode;
					if (
						!status ||
						status < 200 ||
						status > 599 ||
						(message.headers["content-encoding"] && message.headers["content-encoding"] !== "identity")
					) {
						throw new Error("OWNER_PROVIDER_HTTP_RESPONSE");
					}
					const responseHeaders = new Headers();
					for (let i = 0; i < message.rawHeaders.length; i += 2)
						responseHeaders.append(message.rawHeaders[i], message.rawHeaders[i + 1]);
					const iterator: AsyncIterator<unknown> = message[Symbol.asyncIterator]();
					let received = 0;
					const stream = new ReadableStream<Uint8Array>({
						async pull(controller) {
							try {
								const next = await iterator.next();
								if (next.done) {
									if (!message.complete) throw new Error("OWNER_PROVIDER_HTTP_INCOMPLETE");
									bodyComplete = true;
									controller.close();
									bodyDone();
								} else {
									prepared.signal.throwIfAborted();
									if (!Buffer.isBuffer(next.value)) throw new Error("OWNER_PROVIDER_RESPONSE_BYTES");
									received += next.value.length;
									if (received > maxResponseBytes) throw new Error("OWNER_PROVIDER_RESPONSE_BYTES");
									controller.enqueue(new Uint8Array(next.value));
								}
							} catch (error) {
								controller.error(error);
								fail(error);
							}
						},
						async cancel() {
							fail(new Error("OWNER_PROVIDER_BODY_CANCELLED"));
							await iterator.return?.();
						},
					});
					const delivered = new Response(stream, { status, headers: responseHeaders });
					if (count) {
						countResponse = delivered;
						void delivered
							.text()
							.then((text) => {
								if (
									!delivered.ok ||
									delivered.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !==
										"application/json"
								) {
									throw new Error("OWNER_COUNT_HTTP_RESPONSE");
								}
								inputTokens = parseResponsesTokenCount(text);
								parserDone();
							})
							.catch(fail);
					} else if (delivered.ok)
						observeResponsesEvidence(delivered, wireModel, (value) => {
							if (evidence) throw new Error("OWNER_PROVIDER_PARSER_REPLAY");
							evidence = value;
							try {
								record(value);
							} catch (error) {
								errors.push(error);
								throw error;
							} finally {
								parserDone();
							}
						});
					else {
						evidence = { responseId: null, terminal: null, usage: null, streamEnded: false, conflict: false };
						try {
							record(evidence);
						} finally {
							parserDone();
						}
					}
					resolveHeaders(delivered);
				} catch (error) {
					fail(error);
				}
			});
			closes.push(new Promise<void>((resolve) => request!.once("close", () => resolve())));
			request.on("error", fail);
			await Promise.race([secure, interrupted]);
			// TLS setup can outlive authority. No HTTP bytes/key are queued until
			// the original owner and exact delivered credential pass the final check.
			if (request.headersSent) throw new Error("OWNER_PROVIDER_EARLY_HEADERS");
			const outgoing = beforeSend(
				new Request(prepared.url, {
					method: "POST",
					headers: initialHeaders,
					body: bytes,
					redirect: "error",
					signal: prepared.signal,
				}),
				bytes,
			);
			if (outgoing.url !== prepared.url || outgoing.method !== "POST")
				throw new Error("OWNER_PROVIDER_REQUEST_CHANGED");
			for (const [name, value] of outgoing.headers) {
				if (!["host", "transfer-encoding", "content-length", "accept-encoding", "connection"].includes(name))
					request.setHeader(name, value);
			}
			outgoing.signal.throwIfAborted();
			request.end(bytes);
			await Promise.race([Promise.all([body, parser]), interrupted]);
		} catch (error) {
			if (!errors.includes(error)) errors.push(error);
			rejectHeaders(error);
		} finally {
			destroy();
			await Promise.all(closes);
			prepared.signal.removeEventListener("abort", abort);
		}
		if (count && bodyComplete && inputTokens !== undefined && countResponse) {
			// Count protocol completion is separate from inference terminal evidence.
			// A typed authenticated result plus physical close retires only THIS count.
			try {
				custody.retire(count.requestId, "counted");
				if (!errors.length) {
					countResult = Object.freeze({ inputTokens });
					countResults.set(countResult, { binding: count.binding, response: countResponse });
				}
			} catch (error) {
				errors.push(error);
			}
		} else if (
			bodyComplete &&
			evidence?.streamEnded &&
			!evidence.conflict &&
			evidence.responseId &&
			evidence.terminal
		) {
			// A late abort/collector failure cannot erase a genuine terminal. Native
			// still verifies H's FD closure and closes its held kernel reference.
			try {
				custody.retire(evidence.responseId, evidence.terminal);
			} catch (error) {
				errors.push(error);
			}
		} else if (!errors.length) errors.push(new Error("OWNER_PROVIDER_REMOTE_UNKNOWN"));
		if (errors.length === 1) throw errors[0];
		if (errors.length) throw new AggregateError(errors, "OWNER_PROVIDER_EXCHANGE_FAILED", { cause: errors[0] });
	})();
	const counted = count
		? settled.then(() => {
				if (!countResult) throw new Error("OWNER_COUNT_RESPONSE_SCOPE");
				return countResult;
			})
		: undefined;
	// Observe immediately even when the owning caller first joins settlement.
	void counted?.catch(() => {});
	return Object.freeze({ response, settled, countResult: counted });
}
