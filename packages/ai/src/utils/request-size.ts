import type { Api, Context, Model, TranscriptContext } from "../types.ts";

const MIB = 1024 * 1024;
export const DEFAULT_REQUEST_IMAGE_BUDGET_BYTES = 12 * MIB;
export const DEFAULT_MAX_REQUEST_BYTES = 16 * MIB;

export interface FitRequestImagesResult {
	payload: unknown;
	imagesOmitted: number;
	bytesSaved: number;
	requestBytes: number;
}

/** A local admission failure, not a token overflow or a reason to retry/compact the transcript. */
export class RequestTooLargeError extends Error {
	readonly requestBytes: number;
	readonly maxRequestBytes: number;
	readonly imagesOmitted: number;
	readonly bytesSaved: number;

	constructor(requestBytes: number, maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES, imagesOmitted = 0, bytesSaved = 0) {
		super(
			`request too large: ${Math.ceil((requestBytes / MIB) * 100) / 100} MiB > ${Number((maxRequestBytes / MIB).toFixed(6))} MiB; start a new session or reduce attachments`,
		);
		this.name = "RequestTooLargeError";
		this.requestBytes = requestBytes;
		this.maxRequestBytes = maxRequestBytes;
		this.imagesOmitted = imagesOmitted;
		this.bytesSaved = bytesSaved;
	}
}

export type UnsupportedRequestPayloadReason = "api" | "conversation" | "image" | "bedrock-sdk-bytes" | "serialization";

/** Serialization failures carry no arbitrary payload or error text. Unknown conversation paths are skipped. */
export class UnsupportedRequestPayloadError extends Error {
	readonly reason: UnsupportedRequestPayloadReason;

	constructor(reason: UnsupportedRequestPayloadReason) {
		super(
			`Cannot fit request images: unsupported request payload shape (${reason}); start a new session or reduce attachments`,
		);
		this.name = "UnsupportedRequestPayloadError";
		this.reason = reason;
	}
}

type ObjectValue = Record<string, unknown>;
type TextShape = "text" | "input_text" | "part";

interface OriginalImage {
	order: number;
	protected: boolean;
	label: string;
}

interface PayloadImage {
	data: string;
	label?: string;
	/** Wire occurrence order, used to break ties between duplicates. */
	index: number;
	prepare(text: string): { bytesSaved: number; apply(): void };
}

function object(value: unknown): ObjectValue | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as ObjectValue) : undefined;
}

function jsonBytes(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).length;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let index = 0; index < bytes.length; index += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	}
	return btoa(binary);
}

function bedrockSourceForJson(value: unknown): unknown {
	const block = object(value);
	const source = object(block?.source);
	return source?.bytes instanceof Uint8Array
		? { ...block, source: { ...source, bytes: bytesToBase64(source.bytes) } }
		: value;
}

/** Measurement only: these are Smithy's ConverseStream blob paths, not arbitrary JSON documents. */
function bedrockBlockForJson(value: unknown, kind: "content" | "toolResult" | "system" = "content"): unknown {
	const block = object(value);
	if (!block) return value;
	const copy = { ...block };
	const media =
		kind === "content"
			? ["image", "document", "video", "audio"]
			: kind === "toolResult"
				? ["image", "document", "video"]
				: [];
	for (const key of media) {
		if (block[key] !== undefined) copy[key] = bedrockSourceForJson(block[key]);
	}
	if (kind !== "toolResult") {
		const guard = object(block.guardContent);
		if (guard?.image !== undefined) copy.guardContent = { ...guard, image: bedrockSourceForJson(guard.image) };
	}
	if (kind === "content") {
		const reasoning = object(block.reasoningContent);
		if (reasoning?.redactedContent instanceof Uint8Array) {
			copy.reasoningContent = { ...reasoning, redactedContent: bytesToBase64(reasoning.redactedContent) };
		}
		const result = object(block.toolResult);
		if (Array.isArray(result?.content)) {
			copy.toolResult = {
				...result,
				content: result.content.map((entry) => bedrockBlockForJson(entry, "toolResult")),
			};
		}
	}
	return copy;
}

function serializePayload(payload: unknown, api?: Api): string {
	try {
		const root = api === "bedrock-converse-stream" ? object(payload) : undefined;
		if (root) {
			// Do not return this projection: retained SDK bytes and all caller options must keep their identity.
			const projection: ObjectValue = {
				...root,
				...(Array.isArray(root.messages) && {
					messages: root.messages.map((value) => {
						const message = object(value);
						return Array.isArray(message?.content)
							? { ...message, content: message.content.map((entry) => bedrockBlockForJson(entry)) }
							: value;
					}),
				}),
				...(Array.isArray(root.system) && {
					system: root.system.map((entry) => bedrockBlockForJson(entry, "system")),
				}),
			};
			// Smithy binds only the top-level modelId to the URL path, not the JSON body.
			delete projection.modelId;
			payload = projection;
		}
		const json = JSON.stringify(payload);
		if (json !== undefined) return json;
	} catch {}
	throw new UnsupportedRequestPayloadError("serialization");
}

function originalImages(transcript: Context | TranscriptContext): Map<string, OriginalImage[]> {
	const images = new Map<string, OriginalImage[]>();
	const latestUser = transcript.messages.findLastIndex((message) => message.role === "user");
	let order = 0;
	for (const [messageIndex, message] of transcript.messages.entries()) {
		if ((message.role !== "user" && message.role !== "toolResult") || !Array.isArray(message.content)) continue;
		for (const content of message.content) {
			if (content.type !== "image") continue;
			const image: OriginalImage = {
				order: order++,
				protected: messageIndex === latestUser,
				label: message.role === "toolResult" ? message.toolCallId : `user image ${order}`,
			};
			const occurrences = images.get(content.data);
			if (occurrences) occurrences.push(image);
			else images.set(content.data, [image]);
		}
	}
	return images;
}

function imageData(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	// Match normalized base64 data without interpreting arbitrary text or decoding image bytes.
	if (value.startsWith("data:")) {
		const separator = value.indexOf(";base64,");
		if (separator < 0) return undefined;
		return value.slice(separator + 8);
	}
	return value;
}

/** Copy only branches the omission closures can modify; SDK options, signals, arguments and schemas stay intact. */
function copyConversationPayload(payload: unknown, api: Api): unknown {
	const root = object(payload);
	if (!root) return payload;
	const copy = { ...root };
	if (api === "google-generative-ai" || api === "google-vertex") {
		if (!Array.isArray(root.contents)) return copy;
		copy.contents = root.contents.map((value) => {
			const message = object(value);
			if (!message || !Array.isArray(message.parts)) return value;
			return {
				...message,
				parts: message.parts.map((value) => {
					const part = object(value);
					const response = object(part?.functionResponse);
					return response && Array.isArray(response.parts)
						? { ...part, functionResponse: { ...response, parts: [...response.parts] } }
						: value;
				}),
			};
		});
		return copy;
	}
	const context = api === "pi-messages" ? object(root.context) : undefined;
	const owner = context ?? root;
	const key =
		api === "openai-responses" || api === "azure-openai-responses" || api === "openai-codex-responses"
			? "input"
			: "messages";
	if (!Array.isArray(owner[key])) return copy;
	const messages = owner[key].map((value) => {
		const message = object(value);
		if (!message) return value;
		const next = { ...message };
		if (Array.isArray(message.output)) next.output = [...message.output];
		if (Array.isArray(message.content)) {
			next.content = message.content.map((value) => {
				const block = object(value);
				if (api === "anthropic-messages" && block?.type === "tool_result" && Array.isArray(block.content)) {
					return { ...block, content: [...block.content] };
				}
				const result = api === "bedrock-converse-stream" ? object(block?.toolResult) : undefined;
				return result && Array.isArray(result.content)
					? { ...block, toolResult: { ...result, content: [...result.content] } }
					: value;
			});
		}
		return next;
	});
	if (context) copy.context = { ...context, messages };
	else copy[key] = messages;
	return copy;
}

/** Explicit provider conversation paths only. The returned closures modify copy-on-write conversation branches. */
function discoverImages(payload: ObjectValue, api: Api): PayloadImage[] {
	const images: PayloadImage[] = [];
	const add = (blocks: unknown[], index: number, data: unknown, shape: TextShape, label?: unknown): void => {
		const block = object(blocks[index]);
		const source =
			api === "bedrock-converse-stream" && data instanceof Uint8Array ? bytesToBase64(data) : imageData(data);
		if (source === undefined) return;
		images.push({
			data: source,
			label: typeof label === "string" ? label : undefined,
			index: images.length,
			prepare(text) {
				const replacement: ObjectValue = shape === "part" ? { text } : { type: shape, text };
				// Anthropic cache directives remain attached to the replacement content block.
				if (block?.cache_control !== undefined) replacement.cache_control = block.cache_control;
				if (block?.thoughtSignature !== undefined) replacement.thoughtSignature = block.thoughtSignature;
				return {
					bytesSaved:
						jsonBytes(api === "bedrock-converse-stream" ? bedrockBlockForJson(block) : block) -
						jsonBytes(replacement),
					apply: () => {
						blocks[index] = replacement;
					},
				};
			},
		});
	};

	if (api === "google-generative-ai" || api === "google-vertex") {
		if (!Array.isArray(payload.contents)) return images;
		for (const value of payload.contents) {
			const message = object(value);
			if (message?.role !== "user" || !Array.isArray(message.parts)) continue;
			const parts = message.parts;
			for (const [index, value] of parts.entries()) {
				const part = object(value);
				const inline = object(part?.inlineData);
				const file = object(part?.fileData);
				if (typeof inline?.mimeType === "string" && inline.mimeType.startsWith("image/")) {
					add(parts, index, inline.data, "part");
				} else if (typeof file?.mimeType === "string" && file.mimeType.startsWith("image/")) {
					add(parts, index, file.fileUri, "part");
				}
				const response = object(part?.functionResponse);
				if (!Array.isArray(response?.parts)) continue;
				for (const value of response.parts) {
					const image = object(value);
					const source = object(image?.inlineData) ?? object(image?.fileData);
					if (typeof source?.mimeType !== "string" || !source.mimeType.startsWith("image/")) continue;
					const data = imageData(source.data ?? source.fileUri);
					if (data === undefined) continue;
					// FunctionResponsePart cannot contain text. Keep response.output/error untouched; place the
					// omission notice beside the function response in the enclosing user message instead.
					images.push({
						data,
						label: typeof response.id === "string" ? response.id : undefined,
						index: images.length,
						prepare(text) {
							const current = response.parts as unknown[];
							const occurrence = current.indexOf(value);
							const remaining = current.filter((_entry, index) => index !== occurrence);
							const next = { ...response };
							if (remaining.length === 0) delete next.parts;
							else next.parts = remaining;
							const notice = { text };
							return {
								bytesSaved: jsonBytes(response) - jsonBytes(next) - jsonBytes(notice) - 1,
								apply() {
									if (remaining.length === 0) delete response.parts;
									else response.parts = remaining;
									parts.push(notice);
								},
							};
						},
					});
				}
			}
		}
		return images;
	}

	let messages: unknown;
	if (api === "pi-messages") messages = object(payload.context)?.messages;
	else if (api === "openai-responses" || api === "azure-openai-responses" || api === "openai-codex-responses") {
		messages = payload.input;
	} else if (
		api === "anthropic-messages" ||
		api === "openai-completions" ||
		api === "mistral-conversations" ||
		api === "bedrock-converse-stream"
	) {
		messages = payload.messages;
	} else {
		return images;
	}
	if (!Array.isArray(messages)) return images;
	for (const value of messages) {
		const message = object(value);
		if (!message) continue;
		if (
			(api === "openai-responses" || api === "azure-openai-responses" || api === "openai-codex-responses") &&
			(message.type === "function_call_output" || message.type === "custom_tool_call_output")
		) {
			if (!Array.isArray(message.output)) continue;
			for (const [index, value] of message.output.entries()) {
				const block = object(value);
				if (block?.type === "input_image")
					add(message.output, index, block.image_url, "input_text", message.call_id);
			}
			continue;
		}
		if (message.role !== "user" && message.role !== "tool" && message.role !== "toolResult") continue;
		if (!Array.isArray(message.content)) continue;
		for (const [index, value] of message.content.entries()) {
			const block = object(value);
			if (!block) continue;
			if (api === "anthropic-messages") {
				if (block.type === "image") {
					const source = object(block.source);
					add(message.content, index, source?.data ?? source?.url, "text");
				} else if (block.type === "tool_result" && Array.isArray(block.content)) {
					for (const [nestedIndex, value] of block.content.entries()) {
						const nested = object(value);
						if (nested?.type !== "image") continue;
						const source = object(nested.source);
						add(block.content, nestedIndex, source?.data ?? source?.url, "text", block.tool_use_id);
					}
				}
			} else if (api === "pi-messages") {
				if (block.type === "image") add(message.content, index, block.data, "text", message.toolCallId);
			} else if (api === "bedrock-converse-stream") {
				const addBedrock = (blocks: unknown[], index: number, image: ObjectValue, label?: unknown): void => {
					add(blocks, index, object(image.source)?.bytes, "part", label);
				};
				const image = object(block.image);
				const result = object(block.toolResult);
				if (image) addBedrock(message.content, index, image);
				else if (Array.isArray(result?.content)) {
					for (const [nestedIndex, value] of result.content.entries()) {
						const image = object(object(value)?.image);
						if (image) addBedrock(result.content, nestedIndex, image, result.toolUseId);
					}
				}
			} else if ((api === "openai-completions" || api === "mistral-conversations") && block.type === "image_url") {
				const url = api === "mistral-conversations" ? block.imageUrl : object(block.image_url)?.url;
				add(message.content, index, url, "text", message.toolCallId ?? message.tool_call_id);
			} else if (
				(api === "openai-responses" || api === "azure-openai-responses" || api === "openai-codex-responses") &&
				block.type === "input_image"
			) {
				add(message.content, index, block.image_url, "input_text");
			}
		}
	}
	return images;
}

/**
 * Fit the final caller-transformed provider JSON, not a context/token estimate. Call this AFTER onPayload.
 *
 * The target is soft when nonimage content alone exceeds it; the hard cap is always enforced. Latest user
 * images are omitted last, oldest first within each priority. Matching consumes transcript occurrences, so
 * repeated identical screenshots do not accidentally inherit the priority/tool id of the first occurrence.
 *
 * Under target, preserves payload identity. Otherwise operates on a detached snapshot; neither the original
 * payload nor transcript is changed. Unknown paths/encodings are left intact, never searched recursively.
 * Bedrock's known SDK blob fields are measured as base64 JSON strings, without changing native byte sources.
 * Bedrock's path-bound modelId is excluded from measurement; other parameter fields remain included.
 */
export function fitRequestImages(
	payload: unknown,
	model: Model<Api>,
	transcript: Context | TranscriptContext,
	budgetBytes = DEFAULT_REQUEST_IMAGE_BUDGET_BYTES,
): FitRequestImagesResult {
	if (!Number.isSafeInteger(budgetBytes) || budgetBytes <= 0)
		throw new RangeError("Request image budget must be a positive integer");
	const configuredMax = model.inputLimits?.maxRequestBytes;
	const maxRequestBytes = Math.min(
		DEFAULT_MAX_REQUEST_BYTES,
		typeof configuredMax === "number" && Number.isFinite(configuredMax) && configuredMax > 0
			? Math.max(1, Math.floor(configuredMax))
			: DEFAULT_MAX_REQUEST_BYTES,
	);
	const target = Math.min(budgetBytes, maxRequestBytes);
	const json = serializePayload(payload, model.api);
	const initialBytes = new TextEncoder().encode(json).length;
	if (initialBytes <= target) return { payload, imagesOmitted: 0, bytesSaved: 0, requestBytes: initialBytes };

	const copy = copyConversationPayload(payload, model.api);
	const root = object(copy);
	const originals = originalImages(transcript);
	const consumed = new Map<string, number>();
	const candidates = (root ? discoverImages(root, model.api) : []).map((image) => {
		const matches = originals.get(image.data);
		const occurrence = consumed.get(image.data) ?? 0;
		consumed.set(image.data, occurrence + 1);
		// An extra duplicate inserted by a caller conservatively inherits the newest matching occurrence.
		const original = matches?.[Math.min(occurrence, matches.length - 1)];
		return { image, original };
	});
	candidates.sort(
		(a, b) =>
			Number(a.original?.protected ?? false) - Number(b.original?.protected ?? false) ||
			(a.original?.order ?? Number.MAX_SAFE_INTEGER) - (b.original?.order ?? Number.MAX_SAFE_INTEGER) ||
			a.image.index - b.image.index,
	);
	let requestBytes = initialBytes;
	let imagesOmitted = 0;
	for (const { image, original } of candidates) {
		if (requestBytes <= target) break;
		const label = (original?.label ?? image.label ?? `image ${image.index + 1}`)
			.replace(/[\r\n\t]/g, " ")
			.slice(0, 160);
		const text = `[image omitted to fit request size: ${label}, ${Math.ceil(new TextEncoder().encode(image.data).length / 1024)} KB]`;
		const omission = image.prepare(text);
		// Tiny images can be smaller than a useful notice. Omitting those cannot help the request fit.
		if (omission.bytesSaved <= 0) continue;
		omission.apply();
		requestBytes -= omission.bytesSaved;
		imagesOmitted++;
	}
	// The authoritative final measurement includes notices, UTF-8, JSON escaping and all nonimage fields.
	requestBytes = new TextEncoder().encode(serializePayload(copy, model.api)).length;
	if (requestBytes > maxRequestBytes) {
		throw new RequestTooLargeError(requestBytes, maxRequestBytes, imagesOmitted, initialBytes - requestBytes);
	}
	return {
		payload: imagesOmitted === 0 ? payload : copy,
		imagesOmitted,
		bytesSaved: initialBytes - requestBytes,
		requestBytes,
	};
}
