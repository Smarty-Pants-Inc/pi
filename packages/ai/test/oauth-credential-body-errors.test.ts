// pi#150 security round 3 and review R3: an OAuth rejection must carry no credential material in
// any property, not only its message. Malformed success bodies, body-reader failures and echoed
// error codes are checked on the whole serialized rejection object.
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redactOAuthDiagnosticValue } from "../src/auth/oauth/credential-response.ts";
import { githubCopilotOAuth } from "../src/auth/oauth/github-copilot.ts";
import { createRadiusOAuth } from "../src/auth/oauth/radius.ts";
import type { ProviderAuthInteraction } from "../src/auth/types.ts";

const SECRET = "SECRETVALUE150XYZ";
// V8 parse errors quote about ten characters of the body.
const SECRET_PREFIX = SECRET.slice(0, 8);
const signal = new AbortController().signal;

function serialized(error: unknown): string {
	return [
		inspect(error, { showHidden: true, depth: Number.POSITIVE_INFINITY }),
		JSON.stringify(error),
		JSON.stringify(redactOAuthDiagnosticValue(error)),
	].join("\n");
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => {
			throw new Error("expected a rejection");
		},
		(error: unknown) => error,
	);
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Success bodies whose parsing or reading fails with the credential in the native error. */
const brokenSuccessBodies: [string, () => Response][] = [
	["a bare credential", () => new Response(SECRET, { status: 200 })],
	["a truncated token object", () => new Response(`{"access_token":"${SECRET}`, { status: 200 })],
	[
		"a body-reader failure",
		() =>
			new Response(
				new ReadableStream({
					pull(controller) {
						controller.error(new Error(`stream broke near ${SECRET}`));
					},
				}),
				{ status: 200 },
			),
	],
];

function urlOf(input: unknown): string {
	return input instanceof Request ? input.url : String(input);
}

function deviceInteraction(): ProviderAuthInteraction {
	return { signal, prompt: async () => "device-code", notify: () => {} };
}

describe("OAuth credential body errors", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	describe("Radius", () => {
		const gateway = "https://radius.example";
		const refresh = () =>
			createRadiusOAuth({ name: "Radius", gateway }).refresh(
				{ type: "oauth", access: "old-access", refresh: SECRET, expires: 0 },
				signal,
			);

		it.each(brokenSuccessBodies)("refresh with %s keeps no credential", async (_, body) => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => body()),
			);
			const error = await rejectionOf(refresh());
			expect((error as Error).message).toBe("Radius OAuth token response is invalid JSON");
			expect(serialized(error)).not.toContain(SECRET_PREFIX);
		});

		it.each(brokenSuccessBodies)("device authorization with %s keeps no credential", async (_, body) => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => body()),
			);
			const error = await rejectionOf(createRadiusOAuth({ name: "Radius", gateway }).login(deviceInteraction()));
			expect((error as Error).message).toBe("Radius OAuth device authorization response is invalid JSON");
			expect(serialized(error)).not.toContain(SECRET_PREFIX);
		});

		it("an echoed error code is not retained on the rejection", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => jsonResponse({ error: SECRET, error_description: SECRET }, 400)),
			);
			const error = await rejectionOf(refresh());
			expect((error as Error).message).toBe("Radius OAuth token request failed: authorization_error");
			expect((error as { oauthError?: string }).oauthError).toBe("authorization_error");
			expect(serialized(error)).not.toContain(SECRET_PREFIX);
		});

		it.each(brokenSuccessBodies.slice(1))("a non-2xx response with %s shows only the status", async (_, body) => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response(body().body, { status: 400 })),
			);
			const error = await rejectionOf(refresh());
			expect((error as Error).message).toBe("Radius OAuth token request failed: 400");
			expect(serialized(error)).not.toContain(SECRET_PREFIX);
		});

		it("device polling still branches on allowlisted codes and drops an echoed one", async () => {
			vi.useFakeTimers();
			let polls = 0;
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: unknown) => {
					const url = urlOf(input);
					if (url.endsWith("/v1/oauth/device")) {
						return jsonResponse({
							device_code: "device-code-150",
							user_code: "ABCD",
							verification_uri: "https://radius.example/device",
							expires_in: 600,
							interval: 1,
						});
					}
					polls++;
					return jsonResponse({ error: polls === 1 ? "authorization_pending" : SECRET }, 400);
				}),
			);
			const rejection = rejectionOf(createRadiusOAuth({ name: "Radius", gateway }).login(deviceInteraction()));
			await vi.advanceTimersByTimeAsync(5000);
			const error = await rejection;
			expect(polls).toBe(2);
			expect((error as Error).message).toBe("Radius OAuth token request failed: authorization_error");
			expect(serialized(error)).not.toContain(SECRET_PREFIX);
		});
	});

	describe("GitHub Copilot", () => {
		it.each(brokenSuccessBodies)("token refresh with %s keeps no credential", async (_, body) => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => body()),
			);
			const error = await rejectionOf(
				githubCopilotOAuth.refresh({ type: "oauth", access: "old", refresh: "ghu_refresh", expires: 0 }, signal),
			);
			expect((error as Error).message).toBe("GitHub Copilot OAuth response is invalid JSON");
			expect(serialized(error)).not.toContain(SECRET_PREFIX);
		});

		it.each(brokenSuccessBodies)("device login with %s keeps no credential", async (_, body) => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => body()),
			);
			const error = await rejectionOf(
				githubCopilotOAuth.login({ signal, prompt: async () => "", notify: () => {} }),
			);
			expect((error as Error).message).toBe("GitHub Copilot OAuth response is invalid JSON");
			expect(serialized(error)).not.toContain(SECRET_PREFIX);
		});
	});
});
