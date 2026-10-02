// pi#95 / security round 7: payload transforms must not inherit another sender's authority.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, type ImageContent, type TextContent } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type SessionEntry, SessionManager } from "../../../src/core/session-manager.ts";
import { getTurnProvenance, type TurnProvenanceClaim } from "../../../src/core/turn-provenance.ts";
import type { ExtensionAPI } from "../../../src/index.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

vi.mock("../../../src/utils/image-process.ts", () => ({
	processImage: vi.fn(async (data: Buffer, mimeType: string) => ({
		ok: true,
		data: data.toString("base64"),
		mimeType,
		hints: [],
	})),
}));

const RECEIPT = "2026-10-01T00:00:00.000Z";
const LATER = "2026-10-01T00:00:10.000Z";
const original: (TextContent | ImageContent)[] = [
	{ type: "text", text: "admitted" },
	{ type: "image", data: "AA==", mimeType: "image/png" },
];
const claims: Record<"voice" | "fabric", TurnProvenanceClaim> = {
	voice: { channel: "voice", principal: { id: "paul" } },
	fabric: { channel: "fabric", sender: { id: "session:org", kind: "main", verified: "mesh" }, via: "followUp" },
};

function turns(manager: SessionManager): SessionEntry[] {
	return manager
		.getEntries()
		.filter(
			(entry) => entry.type === "custom_message" || (entry.type === "message" && entry.message.role === "user"),
		);
}

function content(entry: SessionEntry) {
	if (entry.type === "custom_message") return entry.content;
	if (entry.type === "message" && entry.message.role === "user") return entry.message.content;
	throw new Error("not a message");
}

function change(payload: string | (TextContent | ImageContent)[], part: "text" | "image") {
	const blocks = typeof payload === "string" ? [{ type: "text" as const, text: payload }] : payload;
	return blocks.map((block) =>
		block.type === part
			? block.type === "text"
				? { ...block, text: "modified" }
				: { ...block, data: "AQ==" }
			: { ...block },
	);
}

describe("regression #95: hook payload attribution", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.useRealTimers();
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	for (const hook of ["input", "message_end"] as const) {
		for (const role of ["user", "custom"] as const) {
			if (hook === "input" && role === "custom") continue; // Custom sends do not enter the input API.
			for (const part of ["text", "image"] as const) {
				for (const channel of ["voice", "fabric"] as const) {
					for (const modifier of ["nonallowlisted", "project", "authorized", "noop"] as const) {
						for (const delivery of ["direct", "steer", "followUp"] as const) {
							it(`${hook} ${role} ${part} ${channel} ${modifier} ${delivery}: queued and reopened attribution`, async () => {
								let api!: ExtensionAPI;
								let release!: () => void;
								let entered!: () => void;
								const held = new Promise<void>((resolve) => {
									release = resolve;
								});
								const ready = new Promise<void>((resolve) => {
									entered = resolve;
								});
								let blockRun = delivery !== "direct";
								const extensions = await createTestExtensionsResult([
									{
										name: "sender",
										factory: (pi) => {
											api = pi;
											pi.on("agent_start", async () => {
												if (blockRun) {
													blockRun = false;
													entered();
													await held;
												}
											});
										},
									},
									{
										name: "modifier",
										factory: (pi) => {
											if (hook === "input")
												pi.on("input", (event) => {
													if (event.text !== "admitted") return;
													vi.setSystemTime(new Date(LATER));
													return {
														action: "transform",
														text: modifier !== "noop" && part === "text" ? "modified" : event.text,
														images: event.images?.map((image) => ({
															...image,
															data: modifier !== "noop" && part === "image" ? "AQ==" : image.data,
														})),
													};
												});
											else
												pi.on("message_end", (event) => {
													if (event.message.role !== role) return;
													const payload = event.message.content;
													if (!JSON.stringify(payload).includes("admitted")) return;
													vi.setSystemTime(new Date(LATER));
													return {
														message: {
															...event.message,
															content:
																modifier === "noop" ? structuredClone(payload) : change(payload, part),
														} as AgentMessage,
													};
												});
										},
									},
								]);
								if (modifier === "project")
									extensions.extensions[1].sourceInfo = {
										...extensions.extensions[1].sourceInfo,
										scope: "project",
									};
								const allowed = [
									"<inline:sender>",
									...(modifier === "nonallowlisted" ? [] : ["<inline:modifier>"]),
								];
								const harness = await createHarness({
									persistSession: true,
									settings: { turnProvenance: { voiceExtensions: allowed, fabricExtensions: allowed } },
									resourceLoader: createTestResourceLoader({ extensionsResult: extensions }),
								});
								harnesses.push(harness);
								harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
								vi.useFakeTimers({ toFake: ["Date"] });
								let running: Promise<void> | undefined;
								if (delivery !== "direct") {
									running = harness.session.prompt("seed");
									await ready;
								}
								vi.setSystemTime(new Date(RECEIPT));
								if (role === "user") {
									api.sendUserMessage(structuredClone(original), {
										deliverAs: delivery === "direct" ? undefined : delivery,
										provenance: claims[channel],
									});
									if (running) {
										await vi.waitFor(() =>
											expect(harness.session.agent.peekQueuedMessages()).toHaveLength(1),
										);
										release();
										await running;
									}
								} else {
									api.sendMessage(
										{ customType: "admitted-turn", content: structuredClone(original), display: false },
										{
											triggerTurn: true,
											deliverAs: delivery === "direct" ? undefined : delivery,
											provenance: claims[channel],
										},
									);
									if (running) {
										await vi.waitFor(() =>
											expect(harness.session.agent.peekQueuedMessages()).toHaveLength(1),
										);
										release();
										await running;
									}
									await harness.session.waitForIdle();
								}
								await vi.waitFor(() =>
									expect(turns(harness.sessionManager)).toHaveLength(delivery === "direct" ? 1 : 2),
								);
								await harness.session.waitForIdle();
								const entry = turns(harness.sessionManager).at(-1)!;
								const record = getTurnProvenance(entry)!;
								const keepsAttribution = modifier === "authorized" || modifier === "noop";
								expect(record).toMatchObject({
									v: 1,
									turnId: expect.stringMatching(/^[0-9a-f-]{36}$/),
									receivedAt: RECEIPT,
									channel: keepsAttribution ? channel : "terminal",
								});
								if (keepsAttribution)
									expect(channel === "voice" ? record.principal?.id : record.sender?.id).toBe(
										channel === "voice" ? "paul" : "session:org",
									);
								else {
									expect(record.principal).toBeUndefined();
									expect(record.sender).toBeUndefined();
									expect(record.via).toBeUndefined();
								}
								expect(content(entry)).toEqual(modifier === "noop" ? original : change(original, part));
								const reopened = SessionManager.open(harness.sessionManager.getSessionFile()!, harness.tempDir);
								expect(getTurnProvenance(turns(reopened).at(-1)!)).toEqual(record);
								expect(content(turns(reopened).at(-1)!)).toEqual(content(entry));
							});
						}
					}
				}
			}
		}
	}

	for (const part of ["text", "image"] as const) {
		it(`input custom ${part}: custom sends bypass input handlers and keep attribution`, async () => {
			let api!: ExtensionAPI;
			const input = vi.fn(() => ({
				action: "transform" as const,
				text: "modified",
				images: [{ type: "image" as const, data: "AQ==", mimeType: "image/png" }],
			}));
			const harness = await createHarness({
				persistSession: true,
				settings: { turnProvenance: { voiceExtensions: ["<inline:sender>"] } },
				extensionFactories: [
					{
						name: "sender",
						factory: (pi) => {
							api = pi;
						},
					},
					{
						name: "modifier",
						factory: (pi) => {
							pi.on("input", input);
						},
					},
				],
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("done")]);
			api.sendMessage(
				{ customType: "custom", content: part === "text" ? "admitted" : original, display: false },
				{ triggerTurn: true, provenance: claims.voice },
			);
			await harness.session.waitForIdle();
			expect(input).not.toHaveBeenCalled();
			expect(getTurnProvenance(turns(harness.sessionManager)[0])?.channel).toBe("voice");
			expect(turns(SessionManager.open(harness.sessionManager.getSessionFile()!, harness.tempDir))).toEqual(
				turns(harness.sessionManager),
			);
		});
	}

	for (const hook of ["input", "message_end"] as const) {
		for (const inPlace of [false, true]) {
			it(`${hook} tracks each harness-bound modifier (${inPlace ? "in-place mutation" : "replacement restored by authorized hook"})`, async () => {
				let api!: ExtensionAPI;
				const harness = await createHarness({
					persistSession: true,
					settings: { turnProvenance: { voiceExtensions: ["<inline:sender>", "<inline:last>"] } },
					extensionFactories: [
						{
							name: "sender",
							factory: (pi) => {
								api = pi;
							},
						},
						{
							name: "modifier",
							factory: (pi) => {
								if (hook === "input")
									pi.on("input", (event) => {
										if (inPlace) {
											if (event.images?.[0]) event.images[0].data = "AQ==";
											return;
										}
										return { action: "transform", text: "modified" };
									});
								else
									pi.on("message_end", (event) => {
										if (event.message.role !== "user") return;
										if (inPlace) {
											event.message.content = "modified";
											return;
										}
										return { message: { ...event.message, content: "modified" } };
									});
							},
						},
						{
							name: "last",
							factory: (pi) => {
								if (inPlace) return;
								if (hook === "input") pi.on("input", () => ({ action: "transform", text: "admitted" }));
								else
									pi.on("message_end", (event) =>
										event.message.role === "user"
											? { message: { ...event.message, content: structuredClone(original) } }
											: undefined,
									);
							},
						},
					],
				});
				harnesses.push(harness);
				harness.setResponses([fauxAssistantMessage("done")]);
				api.sendUserMessage(structuredClone(original), { provenance: claims.voice });
				await vi.waitFor(() => expect(turns(harness.sessionManager)).toHaveLength(1));
				await harness.session.waitForIdle();
				const entry = turns(harness.sessionManager)[0];
				expect(getTurnProvenance(entry)?.channel).toBe("terminal");
				expect(
					getTurnProvenance(
						turns(SessionManager.open(harness.sessionManager.getSessionFile()!, harness.tempDir))[0],
					),
				).toEqual(getTurnProvenance(entry));
			});
		}
	}

	for (const hook of ["input", "message_end"] as const) {
		it(`${hook} unauthorized keyboard payload edit drops its principal`, async () => {
			const harness = await createHarness({
				persistSession: true,
				inputAttestation: { attest: () => ({ principal: "paul" }) },
				extensionFactories: [
					{
						name: "modifier",
						factory: (pi) => {
							if (hook === "input") pi.on("input", () => ({ action: "transform", text: "modified" }));
							else
								pi.on("message_end", (event) =>
									event.message.role === "user"
										? { message: { ...event.message, content: "modified" } }
										: undefined,
								);
						},
					},
				],
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({ mode: "tui" });
			harness.setResponses([fauxAssistantMessage("done")]);
			await harness.session.prompt("admitted");
			expect(getTurnProvenance(turns(harness.sessionManager)[0])?.channel).toBe("terminal");
			expect(getTurnProvenance(turns(harness.sessionManager)[0])?.principal).toBeUndefined();
			expect(turns(SessionManager.open(harness.sessionManager.getSessionFile()!, harness.tempDir))).toEqual(
				turns(harness.sessionManager),
			);
		});
	}

	it("message_end payload-equivalent string/block replacement preserves attribution", async () => {
		let api!: ExtensionAPI;
		const harness = await createHarness({
			persistSession: true,
			settings: { turnProvenance: { voiceExtensions: ["<inline:sender>"] } },
			extensionFactories: [
				{
					name: "sender",
					factory: (pi) => {
						api = pi;
					},
				},
				{
					name: "modifier",
					factory: (pi) => {
						pi.on("message_end", (event) =>
							event.message.role === "user" ? { message: { ...event.message, content: "admitted" } } : undefined,
						);
					},
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		api.sendUserMessage("admitted", { provenance: claims.voice });
		await vi.waitFor(() => expect(turns(harness.sessionManager)).toHaveLength(1));
		await harness.session.waitForIdle();
		expect(getTurnProvenance(turns(harness.sessionManager)[0])?.channel).toBe("voice");
	});

	it("SDK raw Agent replay consumes a published receipt and stamps a fresh terminal occurrence", async () => {
		let api!: ExtensionAPI;
		const harness = await createHarness({
			persistSession: true,
			settings: { turnProvenance: { voiceExtensions: ["<inline:sender>"] } },
			extensionFactories: [
				{
					name: "sender",
					factory: (pi) => {
						api = pi;
					},
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(RECEIPT));
		api.sendUserMessage("admitted", { provenance: claims.voice });
		await vi.waitFor(() => expect(turns(harness.sessionManager)).toHaveLength(1));
		await harness.session.waitForIdle();
		const retained = harness.session.agent.state.messages.find((message) => message.role === "user")!;
		if (retained.role !== "user") throw new Error("missing live user message");
		retained.content = "SDK replacement";
		vi.setSystemTime(new Date(LATER));
		await harness.session.agent.prompt(retained);
		const [first, second] = turns(harness.sessionManager).map(getTurnProvenance);
		expect(first).toMatchObject({ channel: "voice", receivedAt: RECEIPT, principal: { id: "paul" } });
		expect(second).toMatchObject({ channel: "terminal", receivedAt: LATER });
		expect(second?.turnId).not.toBe(first?.turnId);
		expect(second?.principal).toBeUndefined();
		expect(content(turns(harness.sessionManager)[0])).toEqual([{ type: "text", text: "admitted" }]);
		expect(content(turns(harness.sessionManager)[1])).toBe("SDK replacement");
		expect(
			turns(SessionManager.open(harness.sessionManager.getSessionFile()!, harness.tempDir)).map(getTurnProvenance),
		).toEqual([first, second]);
	});
});
