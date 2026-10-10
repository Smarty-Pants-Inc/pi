import { readFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { snapshotUserMessageMetadata } from "../../../src/core/user-message-metadata.ts";
import type {
	ExtensionAPI,
	SendUserMessageOptions,
	SendUserMessageResult,
	UserMessageMetadata,
} from "../../../src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

function nested(depth: number): UserMessageMetadata {
	let value: UserMessageMetadata = { leaf: true };
	for (let index = 1; index < depth; index++) value = { child: value };
	return value;
}

const limits = [
	{
		name: "16 KiB serialized UTF-8 JSON",
		at: () => ({ x: "x".repeat(16_384 - 8) }),
		over: () => ({ x: "x".repeat(16_384 - 7) }),
		code: "INPUT_METADATA_TOO_LARGE",
	},
	{
		name: "16 nested containers (including root)",
		at: () => nested(16),
		over: () => nested(17),
		code: "INPUT_METADATA_TOO_DEEP",
	},
	{
		name: "1,000 object keys",
		at: () => Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [String(index), null])),
		over: () => Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [String(index), null])),
		code: "INPUT_METADATA_TOO_MANY_ITEMS",
	},
	{
		name: "1,000 combined keys and array elements",
		at: () => ({ items: Array(999).fill(null) }),
		over: () => ({ items: Array(1000).fill(null) }),
		code: "INPUT_METADATA_TOO_MANY_ITEMS",
	},
];

describe("#7883 / pi#187 metadata source and bounded admission", () => {
	const harnesses: Harness[] = [];
	const shared = globalThis as typeof globalThis & { pi187BorrowedAPI?: ExtensionAPI };
	afterEach(async () => {
		delete shared.pi187BorrowedAPI;
		for (const harness of harnesses.splice(0).reverse()) {
			await harness.session.waitForIdle();
			harness.cleanup();
		}
	});

	// #7883 / pi#187 P1: the loader, not caller options or payload claims, owns source identity.
	it("stamps extension A and B independently and ignores forged source fields", async () => {
		const apis: ExtensionAPI[] = [];
		const receipts: Array<Promise<SendUserMessageResult>> = [];
		const harness = await createHarness({
			persistSession: true,
			settings: { compaction: { enabled: false } },
			extensionFactories: ["/extensions/A.ts", "/extensions/B.ts"].map((path, index) => ({
				path,
				factory: (pi: ExtensionAPI) => {
					apis.push(pi);
					pi.events.on(`source-submit-${index}`, (options) => {
						receipts[index] = pi.sendUserMessage(
							"source-bound input",
							options as SendUserMessageOptions & { metadata: UserMessageMetadata },
						);
					});
				},
			})),
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("A reply"), fauxAssistantMessage("B reply")]);
		for (const [index, api] of apis.entries()) {
			const forged = { kind: "extension", extensionPath: "/extensions/trusted-fabric.ts" };
			const options = { metadata: { wakeCause: "untrusted claim", metadataSource: forged }, metadataSource: forged };
			api.events.emit(`source-submit-${index}`, options);
			const receipt = await receipts[index]!;
			await harness.session.waitForIdle();
			const source = { kind: "extension", extensionPath: index === 0 ? "/extensions/A.ts" : "/extensions/B.ts" };
			expect(receipt).toMatchObject({ metadataSource: source });
			expect(Object.isFrozen(receipt.metadataSource)).toBe(true);
			const entry = harness.sessionManager.getEntries().find((entry) => entry.id === receipt.entryId);
			expect(entry).toMatchObject({ metadata: options.metadata, metadataSource: source });
			expect(harness.session.messages).not.toContainEqual(expect.objectContaining({ metadataSource: source }));
		}
		const lines: unknown[] = readFileSync(harness.sessionManager.getSessionFile()!, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines).toContainEqual(
			expect.objectContaining({ metadataSource: { kind: "extension", extensionPath: "/extensions/A.ts" } }),
		);
		expect(lines).toContainEqual(
			expect.objectContaining({ metadataSource: { kind: "extension", extensionPath: "/extensions/B.ts" } }),
		);
	});

	// #7883 / pi#187 review: API objects are shareable, but their source identity is not.
	it.each(["global", "event payload"] as const)("rejects extension A borrowing B's API via %s", async (transport) => {
		const apis: ExtensionAPI[] = [];
		let call: Promise<SendUserMessageResult> | undefined;
		const harness = await createHarness({
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				{
					path: "/extensions/A.ts",
					factory: (pi) => {
						apis.push(pi);
						pi.events.on("borrow-api", async (payload) => {
							// Cross an await to verify caller identity survives asynchronous callbacks.
							await Promise.resolve();
							const foreign = transport === "global" ? shared.pi187BorrowedAPI! : (payload as ExtensionAPI);
							call = foreign.sendUserMessage("forged B input", { metadata: { wakeCause: "borrowed" } });
							void call.catch(() => {});
						});
					},
				},
				{
					path: "/extensions/B.ts",
					factory: (pi) => {
						apis.push(pi);
						shared.pi187BorrowedAPI = pi;
					},
				},
			],
		});
		harnesses.push(harness);
		apis[1]!.events.emit("borrow-api", apis[1]);
		await Promise.resolve();
		expect(call).toBeDefined();
		await expect(call).rejects.toMatchObject({
			name: "UserMessageMetadataError",
			code: "INPUT_METADATA_SOURCE_MISMATCH",
		});
		expect(harness.session.inputAdmissionCount).toBe(0);
		expect(harness.session.agent.getQueuedMessages()).toEqual([]);
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "message" && entry.message.role === "user"),
		).toEqual([]);
		expect(harness.faux.state.callCount).toBe(0);
	});

	// #7883 / pi#187 review: an SDK caller cannot borrow extension attribution from a captured API.
	it("rejects metadata through a captured API invoked without extension context", async () => {
		let api: ExtensionAPI | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					api = pi;
					pi.on("input", () => ({ action: "handled" }));
				},
			],
		});
		harnesses.push(harness);
		await expect(api!.sendUserMessage("SDK-originated", { metadata: {} })).rejects.toMatchObject({
			name: "UserMessageMetadataError",
			code: "INPUT_METADATA_SOURCE_MISMATCH",
		});
		expect(harness.session.inputAdmissionCount).toBe(0);
		expect(harness.faux.state.callCount).toBe(0);
	});

	// #7883 / pi#187 review: registering A's code through B's API cannot launder it into B's scope.
	it("rejects extension A registering callbacks through B's shared API", async () => {
		let a: ExtensionAPI | undefined;
		let b: ExtensionAPI | undefined;
		let registrationError: unknown;
		const harness = await createHarness({
			extensionFactories: [
				{
					path: "/extensions/A.ts",
					factory: (pi) => {
						a = pi;
						pi.events.on("borrow-registration", () => {
							try {
								b!.on("input", () => ({ action: "handled" }));
							} catch (error) {
								registrationError = error;
							}
						});
					},
				},
				{
					path: "/extensions/B.ts",
					factory: (pi) => {
						b = pi;
					},
				},
			],
		});
		harnesses.push(harness);
		a!.events.emit("borrow-registration", undefined);
		expect(registrationError).toMatchObject({
			name: "UserMessageMetadataError",
			code: "INPUT_METADATA_SOURCE_MISMATCH",
		});
		expect(harness.session.hasExtensionHandlers("input")).toBe(false);
	});

	// #7883 / pi#187 round 3: callbacks registered outside extension execution remain unbound and fail closed.
	it("cannot install extension attribution through an SDK-registered callback", async () => {
		let api: ExtensionAPI | undefined;
		let result: Promise<SendUserMessageResult> | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					api = pi;
					pi.on("input", () => ({ action: "handled" }));
				},
			],
		});
		harnesses.push(harness);
		api!.events.on("sdk-created-callback", () => {
			result = api!.sendUserMessage("SDK callback input", { metadata: {} });
		});
		api!.events.emit("sdk-created-callback", undefined);
		await expect(result).rejects.toMatchObject({
			name: "UserMessageMetadataError",
			code: "INPUT_METADATA_SOURCE_MISMATCH",
		});
		expect(harness.session.inputAdmissionCount).toBe(0);
		expect(harness.faux.state.callCount).toBe(0);
	});

	// #7883 / pi#187 P1: direct SDK calls cannot supply extension identity, including handled input.
	it.each([false, true])("stamps SDK receipts (handled=%s), ignoring options and payload source", async (handled) => {
		const harness = await createHarness({
			settings: { compaction: { enabled: false } },
			extensionFactories: handled
				? [
						(pi) => {
							pi.on("input", () => ({ action: "handled" }));
						},
					]
				: undefined,
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("sdk reply")]);
		const forged = { kind: "extension", extensionPath: "/extensions/A.ts" };
		const receipt = await harness.session.sendUserMessage("sdk input", {
			metadata: { metadataSource: forged },
			...{ metadataSource: forged },
		});
		expect(receipt).toMatchObject({ status: handled ? "handled" : "turnStarted", metadataSource: { kind: "sdk" } });
		await harness.session.waitForIdle();
		if (!handled)
			expect(harness.sessionManager.getEntry(receipt.entryId!)).toMatchObject({ metadataSource: { kind: "sdk" } });
	});

	// #7883 / pi#187 P2: accept exact boundaries, reject over them before admission or queue mutation.
	it.each(limits)("accepts exactly $name", async ({ at }) => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", () => ({ action: "handled" }));
				},
			],
		});
		harnesses.push(harness);
		const metadata = at();
		const receipt = await harness.session.sendUserMessage("boundary input", { metadata });
		expect(receipt).toMatchObject({ status: "handled", metadata });
		expect(Object.isFrozen(receipt.metadata)).toBe(true);
	});

	it.each(limits)("rejects over $name before admission", async ({ over, code }) => {
		const input = vi.fn(() => ({ action: "handled" as const }));
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", input);
				},
			],
		});
		harnesses.push(harness);
		const before = harness.sessionManager.getEntries();
		await expect(harness.session.sendUserMessage("rejected input", { metadata: over() })).rejects.toMatchObject({
			name: "UserMessageMetadataError",
			code,
		});
		expect(input).not.toHaveBeenCalled();
		expect(harness.session.inputAdmissionCount).toBe(0);
		expect(harness.session.agent.getQueuedMessages()).toEqual([]);
		expect(harness.session.isPromptPending).toBe(false);
		expect(harness.sessionManager.getEntries()).toEqual(before);
		expect(harness.faux.state.callCount).toBe(0);
	});

	// #7883 / pi#187 P2: UTF-8 and JSON escaping count, not JS string length.
	it.each(["é", "\u0000", "\ud800", "😀"])("measures escaped UTF-8 bytes for %j", (character) => {
		const overhead = Buffer.byteLength(JSON.stringify({ x: "" }));
		const width = Buffer.byteLength(JSON.stringify(character)) - 2;
		const count = Math.floor((16_384 - overhead) / width);
		const metadata = { x: character.repeat(count) + "x".repeat((16_384 - overhead) % width) };
		expect(Buffer.byteLength(JSON.stringify(metadata))).toBe(16_384);
		expect(snapshotUserMessageMetadata(metadata)).toEqual(metadata);
		expect(() => snapshotUserMessageMetadata({ x: `${metadata.x}x` })).toThrow(
			expect.objectContaining({ code: "INPUT_METADATA_TOO_LARGE" }),
		);
	});

	// #7883 / pi#187 P2: do not finish copying a huge tree before checking its budget.
	it("stops visiting child properties at the item limit", () => {
		let visits = 0;
		const child = new Proxy(
			{},
			{
				ownKeys() {
					visits++;
					return [];
				},
			},
		);
		const metadata = Object.fromEntries(Array.from({ length: 100_000 }, (_, index) => [String(index), child]));
		expect(() => snapshotUserMessageMetadata(metadata)).toThrow(
			expect.objectContaining({ code: "INPUT_METADATA_TOO_MANY_ITEMS" }),
		);
		expect(visits).toBeLessThanOrEqual(1000);
	});

	// #7883 / pi#187 P2: byte and depth caps stop copying before later or over-depth subtrees.
	it.each(["bytes", "depth"] as const)("stops visiting children at the %s cap", (limit) => {
		let visits = 0;
		const child = new Proxy(
			{},
			{
				ownKeys() {
					visits++;
					return [];
				},
			},
		);
		let metadata: UserMessageMetadata;
		if (limit === "bytes") metadata = { huge: "x".repeat(1_000_000), later: child };
		else {
			metadata = child;
			for (let index = 0; index < 16; index++) metadata = { child: metadata };
		}
		expect(() => snapshotUserMessageMetadata(metadata)).toThrow(
			expect.objectContaining({ code: limit === "bytes" ? "INPUT_METADATA_TOO_LARGE" : "INPUT_METADATA_TOO_DEEP" }),
		);
		expect(visits).toBe(0);
	});

	// #7883 / pi#187 SEC P2: Proxy traps must never run during metadata validation.
	it.each(["root", "nested object", "nested array", "revoked"] as const)(
		"rejects %s Proxies without invoking a trap",
		async (location) => {
			let traps = 0;
			const trap = () => {
				traps++;
				throw new Error("Proxy trap executed");
			};
			const target = location === "nested array" ? [] : {};
			const revocable = Proxy.revocable(target, {
				getPrototypeOf: trap,
				ownKeys: trap,
				getOwnPropertyDescriptor: trap,
				get: trap,
			});
			if (location === "revoked") revocable.revoke();
			const metadata = location === "root" || location === "revoked" ? revocable.proxy : { value: revocable.proxy };
			const harness = await createHarness();
			harnesses.push(harness);
			const before = harness.sessionManager.getEntries();
			await expect(harness.session.sendUserMessage("proxy input", { metadata })).rejects.toThrow(
				"cannot contain Proxies",
			);
			expect(traps).toBe(0);
			expect(harness.session.inputAdmissionCount).toBe(0);
			expect(harness.session.agent.getQueuedMessages()).toEqual([]);
			expect(harness.sessionManager.getEntries()).toEqual(before);
			expect(harness.faux.state.callCount).toBe(0);
		},
	);

	// #7883 / pi#187 SEC P2: ownKeys is unavoidable for plain objects; reject its count before inspecting values.
	it("rejects 100k plain-object keys without inspecting any values", () => {
		const metadata = Object.fromEntries(Array.from({ length: 100_000 }, (_, index) => [String(index), null]));
		const descriptors = vi.spyOn(Object, "getOwnPropertyDescriptor");
		let error: unknown;
		let visits = 0;
		try {
			try {
				snapshotUserMessageMetadata(metadata);
			} catch (cause) {
				error = cause;
			}
			visits = descriptors.mock.calls.length;
		} finally {
			descriptors.mockRestore();
		}
		expect(error).toMatchObject({ code: "INPUT_METADATA_TOO_MANY_ITEMS" });
		expect(visits).toBe(0);
	});

	// #7883: keep strict-JSON validation (no getter/toJSON execution, cycles, sparse arrays, or lossy values).
	it("preserves strict JSON validation and safely copies __proto__ keys", () => {
		const getter = vi.fn();
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		for (const metadata of [
			{ x: undefined },
			{ x: NaN },
			{ x: 1n },
			{ x: new Date() },
			{ x: Array(1) },
			Object.defineProperty({}, "x", { get: getter, enumerable: true }),
			cycle,
		]) {
			expect(() => snapshotUserMessageMetadata(metadata)).toThrow(TypeError);
		}
		expect(getter).not.toHaveBeenCalled();
		const metadata = JSON.parse('{"__proto__":{"safe":true}}');
		const snapshot = snapshotUserMessageMetadata(metadata);
		expect(Object.getPrototypeOf(snapshot)).toBe(Object.prototype);
		expect(Object.hasOwn(snapshot, "__proto__")).toBe(true);
		expect(snapshot).toEqual(metadata);
	});
});
