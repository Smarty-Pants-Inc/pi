import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { OrdinaryRequestProvenance } from "../src/core/ordinary-request-provenance.ts";

type RequestIdentity = { requestId: string };
const expiry = () => Date.now() + 10_000;
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
// Pure custody tests: fake loop/provider/retirement, not native acceptance.
async function run(
	p: OrdinaryRequestProvenance<RequestIdentity>,
	token: object | undefined,
	ids: string[],
	retirement = Promise.resolve(),
) {
	await p.run(token, async () => {
		const controller = new AbortController();
		p.started(controller.signal);
		await p.stream(controller.signal, async () => {
			const fetch = p.bindFetch(
				Object.assign(
					async () => {
						const original = { requestId: ids.shift()! };
						p.request(original)(retirement);
						return new Response();
					},
					{ preconnect() {} },
				),
			);
			while (ids.length) await fetch("https://synthetic.invalid");
		});
	});
}

test("private prompt/run/stream/request joins exact original reservation and awaits retirement", async () => {
	const p = new OrdinaryRequestProvenance<RequestIdentity>();
	const retired = deferred();
	let returned = false;
	const capture = p
		.capture(
			() => p.prompt((token) => run(p, token, ["actual"], retired.promise)),
			expiry(),
			(original) => original,
		)
		.then((result) => {
			returned = true;
			return result;
		});
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(returned, false);
	retired.resolve();
	assert.deepEqual(await capture, { requestId: "actual" });
});

test("automatic and unrelated work interleave without borrowing the invocation", async () => {
	const p = new OrdinaryRequestProvenance<RequestIdentity>();
	const entered = deferred(),
		release = deferred();
	const capture = p.capture(
		() =>
			p.prompt(async (token) => {
				entered.resolve();
				await release.promise;
				// Automatic path has no prompt token, even inside the same async ancestry.
				await run(p, undefined, ["automatic"]);
				await run(p, token, ["original"]);
			}),
		expiry(),
		(original) => original,
	);
	await entered.promise;
	await p.prompt((token) => run(p, token, ["unrelated"]));
	release.resolve();
	assert.deepEqual(await capture, { requestId: "original" });
});

test("nested prompt from input callback cannot qualify even when it creates the only request", async () => {
	const p = new OrdinaryRequestProvenance<RequestIdentity>();
	await assert.rejects(
		p.capture(
			() => p.prompt(() => p.prompt((token) => run(p, token, ["nested"]))),
			expiry(),
			(r) => r,
		),
		/NO_REQUEST/,
	);
});

test("zero request and multiple actual attempts refuse, never choose first or latest", async () => {
	const p = new OrdinaryRequestProvenance<RequestIdentity>();
	await assert.rejects(
		p.capture(
			() => p.prompt(async () => {}),
			expiry(),
			(r) => r,
		),
		/NO_REQUEST/,
	);
	await assert.rejects(
		p.capture(
			() => p.prompt((token) => run(p, token, ["one", "two"])),
			expiry(),
			(r) => r,
		),
		/MULTIPLE_REQUESTS/,
	);
});

test("retry continuation retains prompt identity but cannot collapse two attempts", async () => {
	const p = new OrdinaryRequestProvenance<RequestIdentity>();
	await assert.rejects(
		p.capture(
			() =>
				p.prompt(async (token) => {
					await run(p, token, ["failed-attempt"]);
					await run(p, token, ["retry"]);
				}),
			expiry(),
			(r) => r,
		),
		/MULTIPLE_REQUESTS/,
	);
});

test("two direct prompts refuse even if only one sends", async () => {
	const p = new OrdinaryRequestProvenance<RequestIdentity>();
	await assert.rejects(
		p.capture(
			async () => {
				await p.prompt(async () => {});
				await p.prompt((token) => run(p, token, ["one"]));
			},
			expiry(),
			(r) => r,
		),
		/PROMPTS/,
	);
});

test("a copied signal without original loop stream scope cannot authenticate a fetch", async () => {
	const p = new OrdinaryRequestProvenance<RequestIdentity>();
	await assert.rejects(
		p.capture(
			() =>
				p.prompt((token) =>
					p.run(token, async () => {
						const controller = new AbortController();
						p.started(controller.signal);
						const fetch = p.bindFetch(
							Object.assign(
								async () => {
									p.request({ requestId: "unscoped" })(Promise.resolve());
									return new Response();
								},
								{ preconnect() {} },
							),
						);
						await fetch("https://synthetic.invalid", { signal: controller.signal });
					}),
				),
			expiry(),
			(r) => r,
		),
		/NO_REQUEST/,
	);
});

test("original invocation and provider failure objects are preserved", async () => {
	const p = new OrdinaryRequestProvenance<RequestIdentity>();
	const original = new Error("original denial");
	await assert.rejects(
		p.capture(
			async () => {
				throw original;
			},
			expiry(),
			(r) => r,
		),
		(cause) => cause === original,
	);
	const retirement = Promise.reject(original);
	void retirement.catch(() => {});
	await assert.rejects(
		p.capture(
			() => p.prompt((token) => run(p, token, ["one"], retirement)),
			expiry(),
			(r) => r,
		),
		(cause) => cause === original,
	);
});

test("overlap is sticky even if the invocation catches its nested refusal", async () => {
	const p = new OrdinaryRequestProvenance<RequestIdentity>();
	await assert.rejects(
		p.capture(
			async () => {
				await assert.rejects(
					p.capture(
						async () => {},
						expiry(),
						(r) => r,
					),
					/OVERLAP/,
				);
				await p.prompt((token) => run(p, token, ["one"]));
			},
			expiry(),
			(r) => r,
		),
		/OVERLAP/,
	);
});

test("close settles an uncooperative invocation without manufacturing retirement", async () => {
	const p = new OrdinaryRequestProvenance<RequestIdentity>();
	const capture = p.capture(
		() => new Promise(() => {}),
		expiry(),
		(r) => r,
	);
	p.close();
	await assert.rejects(capture, /CLOSED/);
	await assert.rejects(
		p.capture(
			async () => {},
			expiry(),
			(r) => r,
		),
		/CLOSED/,
	);
});

test("abort and allocation deadline settle pending retirement or invocation", async () => {
	const p = new OrdinaryRequestProvenance<RequestIdentity>();
	const original = new Error("original abort");
	const capture = p.capture(
		() => p.prompt((token) => run(p, token, ["one"], new Promise(() => {}))),
		expiry(),
		(r) => r,
	);
	p.interrupt(original);
	await assert.rejects(capture, (cause) => cause === original);
	await assert.rejects(
		p.capture(
			() => new Promise(() => {}),
			Date.now() + 20,
			(r) => r,
		),
		/EXPIRED/,
	);
});

test("detached prompt refuses; late continuation cannot claim another capture", async () => {
	const p = new OrdinaryRequestProvenance<RequestIdentity>();
	const release = deferred();
	let detached!: Promise<void>;
	await assert.rejects(
		p.capture(
			async () => {
				detached = p.prompt(async (token) => {
					await release.promise;
					await run(p, token, ["late"]);
				});
				void detached.catch(() => {});
			},
			expiry(),
			(r) => r,
		),
		/DETACHED/,
	);
	release.resolve();
	await assert.rejects(detached, /STALE/);
	assert.deepEqual(
		await p.capture(
			() => p.prompt((token) => run(p, token, ["fresh"])),
			expiry(),
			(r) => r,
		),
		{ requestId: "fresh" },
	);
});

test("pre-reservation stream failure stays original even if Agent converts it into an error message", async () => {
	const p = new OrdinaryRequestProvenance<RequestIdentity>();
	const cause = new Error("original guard refusal");
	await assert.rejects(
		p.capture(
			() =>
				p.prompt((token) =>
					p.run(token, async () => {
						const controller = new AbortController();
						p.started(controller.signal);
						try {
							await p.stream(controller.signal, async () => {
								throw cause;
							});
						} catch {
							/* Simulates Agent.handleRunFailure, not a successful request. */
						}
					}),
				),
			expiry(),
			(r) => r,
		),
		(error) => error === cause,
	);
});

test("a retained per-stream fetch cannot dispatch after its original run/capture finishes", async () => {
	const p = new OrdinaryRequestProvenance<RequestIdentity>();
	let late!: typeof globalThis.fetch;
	let calls = 0;
	await p.capture(
		() =>
			p.prompt((token) =>
				p.run(token, async () => {
					const controller = new AbortController();
					p.started(controller.signal);
					await p.stream(controller.signal, async () => {
						late = p.bindFetch(
							Object.assign(
								async () => {
									calls++;
									p.request({ requestId: "one" })(Promise.resolve());
									return new Response();
								},
								{ preconnect() {} },
							),
						);
						await late("https://synthetic.invalid");
					});
				}),
			),
		expiry(),
		(r) => r,
	);
	await assert.rejects(late("https://synthetic.invalid"), /STALE/);
	assert.equal(calls, 1);
});

test("entered gated fetch B prevents single-request success for retired A and cannot enroll after capture", async () => {
	const p = new OrdinaryRequestProvenance<RequestIdentity>();
	const entered = deferred(),
		release = deferred();
	let late!: Promise<Response>;
	let dispatchedB = false;
	let selected = false;
	const capture = p.capture(
		() =>
			p.prompt((token) =>
				p.run(token, async () => {
					const controller = new AbortController();
					p.started(controller.signal);
					await p.stream(controller.signal, async () => {
						const fetch = p.bindFetch(
							Object.assign(
								async (input: Parameters<typeof globalThis.fetch>[0]) => {
									const id = String(input).endsWith("/B") ? "B" : "A";
									if (id === "B") {
										entered.resolve();
										await release.promise;
									}
									p.request({ requestId: id })(Promise.resolve());
									if (id === "B") dispatchedB = true;
									return new Response();
								},
								{ preconnect() {} },
							),
						);
						await fetch("https://synthetic.invalid/A");
						late = fetch("https://synthetic.invalid/B");
						void late.catch(() => {});
						await entered.promise;
					});
				}),
			),
		expiry(),
		(r) => {
			selected = true;
			return r;
		},
	);
	try {
		await assert.rejects(capture, /DETACHED/);
		assert.equal(selected, false);
	} finally {
		release.resolve();
	}
	await assert.rejects(late, /STALE/);
	assert.equal(dispatchedB, false);
	assert.deepEqual(
		await p.capture(
			() => p.prompt((token) => run(p, token, ["fresh"])),
			expiry(),
			(r) => r,
		),
		{ requestId: "fresh" },
	);
});

test("settled fetch ancestry cannot enroll detached work even while its original run remains active", async () => {
	const p = new OrdinaryRequestProvenance<RequestIdentity>();
	const release = deferred();
	let late!: Promise<void>;
	await assert.rejects(
		p.capture(
			() =>
				p.prompt((token) =>
					p.run(token, async () => {
						const controller = new AbortController();
						p.started(controller.signal);
						await p.stream(controller.signal, async () => {
							const fetch = p.bindFetch(
								Object.assign(
									async () => {
										p.request({ requestId: "A" })(Promise.resolve());
										late = (async () => {
											await release.promise;
											p.request({ requestId: "B" })(Promise.resolve());
										})();
										void late.catch(() => {});
										return new Response();
									},
									{ preconnect() {} },
								),
							);
							await fetch("https://synthetic.invalid");
							release.resolve();
							await assert.rejects(late, /STALE/);
						});
					}),
				),
			expiry(),
			(r) => r,
		),
		/STALE/,
	);
});

for (const action of ["interrupt", "close", "overlap"] as const) {
	test(`result callback cannot conceal ${action}`, async () => {
		const p = new OrdinaryRequestProvenance<RequestIdentity>();
		const first = new Error("first interruption");
		let nested: Promise<unknown> | undefined;
		await assert.rejects(
			p.capture(
				() => p.prompt((token) => run(p, token, ["one"])),
				expiry(),
				(original) => {
					if (action === "interrupt") {
						p.interrupt(first);
						p.close();
					}
					if (action === "close") p.close();
					if (action === "overlap") {
						nested = p.capture(
							async () => {},
							expiry(),
							(r) => r,
						);
						void nested.catch(() => {});
					}
					return original;
				},
			),
			action === "interrupt" ? (cause) => cause === first : action === "close" ? /CLOSED/ : /OVERLAP/,
		);
		if (nested) await assert.rejects(nested, /OVERLAP/);
	});
}

for (const phase of ["before", "after", "prior-failure"] as const) {
	test(`absolute expiry fences result ${phase} without a timer turn`, async (t) => {
		const p = new OrdinaryRequestProvenance<RequestIdentity>();
		const now = Date.now();
		const first = new Error("first interruption");
		let selected = false;
		t.mock.method(Date, "now", () => now);
		await assert.rejects(
			p.capture(
				async () => {
					await p.prompt((token) => run(p, token, ["one"]));
					if (phase === "before") t.mock.method(Date, "now", () => now + 1000);
				},
				now + 1000,
				(original) => {
					selected = true;
					if (phase === "prior-failure") p.interrupt(first);
					t.mock.method(Date, "now", () => now + 1000);
					return original;
				},
			),
			phase === "prior-failure" ? (cause) => cause === first : /EXPIRED/,
		);
		assert.equal(selected, phase !== "before");
	});
}

test("original prompt input requires exact live context, stream and request identity", async () => {
	const p = new OrdinaryRequestProvenance<RequestIdentity>();
	const foreign = new OrdinaryRequestProvenance<RequestIdentity>();
	const controller = new AbortController();
	const other = new AbortController();
	const message: AgentMessage = { role: "user", content: "original", timestamp: 1 };
	const input = [message];
	let retainedInput: readonly AgentMessage[] | undefined;
	let late!: Promise<void>;
	const release = deferred();
	await p.capture(
		() =>
			p.prompt((token) =>
				p.run(
					token,
					async () => {
						p.started(controller.signal);
						input.length = 0;
						const context = p.originalPromptInput(controller.signal, "context");
						assert.equal(context.signal, controller.signal);
						assert.notEqual(context.input, input);
						assert.equal(context.input[0], message);
						retainedInput = context.input;
						for (const boundary of ["context", "stream", "request"] as const) {
							assert.throws(() => p.originalPromptInput(other.signal, boundary), /ORIGINAL_RUN_REQUIRED/);
							assert.throws(() => p.originalPromptInput(undefined, boundary), /ORIGINAL_RUN_REQUIRED/);
							assert.throws(
								() => foreign.originalPromptInput(controller.signal, boundary),
								/ORIGINAL_RUN_REQUIRED/,
							);
						}
						assert.throws(() => p.originalPromptInput(controller.signal, "stream"), /ORIGINAL_RUN_REQUIRED/);
						assert.throws(() => p.originalPromptInput(controller.signal, "request"), /ORIGINAL_RUN_REQUIRED/);
						await p.stream(controller.signal, async () => {
							assert.equal(p.originalPromptInput(controller.signal, "stream").input, retainedInput);
							assert.throws(() => p.originalPromptInput(controller.signal, "request"), /ORIGINAL_RUN_REQUIRED/);
							const fetch = p.bindFetch(
								Object.assign(
									async () => {
										assert.equal(p.originalPromptInput(controller.signal, "request").input, retainedInput);
										late = (async () => {
											await release.promise;
											assert.throws(
												() => p.originalPromptInput(controller.signal, "request"),
												/ORIGINAL_RUN_REQUIRED/,
											);
										})();
										p.request({ requestId: "original" })(Promise.resolve());
										return new Response();
									},
									{ preconnect() {} },
								),
							);
							await fetch("https://synthetic.invalid");
							release.resolve();
							await late;
						});
					},
					input,
				),
			),
		expiry(),
		(r) => r,
	);
	for (const boundary of ["context", "stream", "request"] as const) {
		assert.throws(() => p.originalPromptInput(controller.signal, boundary), /ORIGINAL_RUN_REQUIRED/);
	}
});

for (const invalid of ["copied-token", "missing-input", "aborted", "closed", "failed"] as const) {
	test(`original prompt input rejects ${invalid} association`, async () => {
		const p = new OrdinaryRequestProvenance<RequestIdentity>();
		const controller = new AbortController();
		const cause = new Error("original failure");
		const message: AgentMessage = { role: "user", content: "original", timestamp: 1 };
		const capture = p.capture(
			() =>
				p.prompt((token) =>
					p.run(
						invalid === "copied-token" ? { ...token } : token,
						async () => {
							p.started(controller.signal);
							if (invalid === "aborted") controller.abort(cause);
							if (invalid === "closed") p.close();
							if (invalid === "failed") p.interrupt(cause);
							for (const boundary of ["context", "stream", "request"] as const) {
								assert.throws(
									() => p.originalPromptInput(controller.signal, boundary),
									/ORIGINAL_RUN_REQUIRED/,
								);
							}
						},
						invalid === "missing-input" ? undefined : message,
					),
				),
			expiry(),
			(r) => r,
		);
		await assert.rejects(
			capture,
			invalid === "aborted" || invalid === "failed"
				? (error) => error === cause
				: invalid === "closed"
					? /CLOSED/
					: /NO_REQUEST/,
		);
	});
}

test("owner stores are disjoint; another owner's sole request is not evidence", async () => {
	const p = new OrdinaryRequestProvenance<RequestIdentity>();
	const foreign = new OrdinaryRequestProvenance<RequestIdentity>();
	await assert.rejects(
		p.capture(
			() => p.prompt(() => foreign.prompt((token) => run(foreign, token, ["foreign"]))),
			expiry(),
			(r) => r,
		),
		/NO_REQUEST/,
	);
});
