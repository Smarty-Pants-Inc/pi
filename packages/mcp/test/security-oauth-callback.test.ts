import { request, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type OAuthCallbackPage, OAuthCallbackServer } from "../src/oauth/index.ts";

// Do not let fetch normalize or reject the target before it reaches the real callback HTTP listener.
function callbackRequest(
	redirectUrl: string,
	target: string,
): Promise<{ status: number; body: string; contentType: string | undefined }> {
	const url = new URL(redirectUrl);
	return new Promise((resolve, reject) => {
		const outgoing = request(
			{ hostname: url.hostname, port: url.port, path: target, method: "GET", agent: false },
			(response) => {
				let body = "";
				response.setEncoding("utf8");
				response.on("data", (chunk: string) => {
					body += chunk;
				});
				response.once("error", reject);
				response.once("end", () =>
					resolve({ status: response.statusCode ?? 0, body, contentType: response.headers["content-type"] }),
				);
			},
		);
		outgoing.once("error", reject);
		outgoing.setTimeout(2_000, () => outgoing.destroy(new Error("Callback request timed out")));
		outgoing.end();
	});
}

describe.sequential("MCP OAuth callback security boundaries", () => {
	afterEach(() => vi.restoreAllMocks());

	// smarty-dev#2241 F7: malformed unauthenticated requests must not throw or consume any pending state.
	it.each(["//[", "//[invalid/callback"])("recovers after malformed request target %s", async (target) => {
		const renderPage = vi.fn((page: OAuthCallbackPage) => (page.ok ? "<p>signed in</p>" : `<p>${page.message}</p>`));
		const callback = await OAuthCallbackServer.listen({ renderPage });
		const first = callback.waitForCallback("first-state");
		const second = callback.waitForCallback("second-state");
		let settled = false;
		first.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		second.catch(() => undefined);
		try {
			const invalid = await callbackRequest(callback.redirectUrl, target);
			expect(invalid).toMatchObject({ status: 400, body: "Invalid OAuth callback request." });
			expect(renderPage).not.toHaveBeenCalled();
			expect(settled).toBe(false);
			expect((await callbackRequest(callback.redirectUrl, "/other")).status).toBe(404);
			expect((await callbackRequest(callback.redirectUrl, "/callback?state=wrong&code=forged")).status).toBe(400);
			expect(settled).toBe(false);

			// Allowed counterexample: valid absolute-form targets, issuer data, and independent sign-ins still work.
			const valid = await callbackRequest(
				callback.redirectUrl,
				`${callback.redirectUrl}?state=first-state&code=good&iss=https%3A%2F%2Fissuer.example`,
			);
			expect(valid).toEqual({ status: 200, body: "<p>signed in</p>", contentType: "text/html; charset=utf-8" });
			await expect(first).resolves.toEqual({ code: "good", state: "first-state", iss: "https://issuer.example" });
			expect((await callbackRequest(callback.redirectUrl, "/callback?state=second-state&code=other")).status).toBe(
				200,
			);
			await expect(second).resolves.toEqual({ code: "other", state: "second-state" });
			expect((await callbackRequest(callback.redirectUrl, "/callback?state=first-state&code=again")).status).toBe(
				400,
			);
		} finally {
			await callback.close();
		}
	});

	// smarty-dev#2241 F7: the exception boundary covers the whole request handler, not only URL parsing.
	it("observes a response failure outside parsing and retains pending state", async () => {
		const callback = await OAuthCallbackServer.listen();
		const pending = callback.waitForCallback("expected-state");
		pending.catch(() => undefined);
		try {
			vi.spyOn(ServerResponse.prototype, "writeHead").mockImplementationOnce(() => {
				throw new Error("response failed before headers");
			});
			expect((await callbackRequest(callback.redirectUrl, "/other")).status).toBe(400);
			expect((await callbackRequest(callback.redirectUrl, "/callback?state=expected-state&code=good")).status).toBe(
				200,
			);
			await expect(pending).resolves.toEqual({ code: "good", state: "expected-state" });
		} finally {
			await callback.close();
		}
	});

	// smarty-dev#2241 F7 countercases: authenticated provider errors and missing codes still reject their own wait.
	it("preserves provider errors and missing-code rejection without consuming another state", async () => {
		const callback = await OAuthCallbackServer.listen();
		const denied = callback.waitForCallback("denied-state");
		const missing = callback.waitForCallback("missing-state");
		const valid = callback.waitForCallback("valid-state");
		denied.catch(() => undefined);
		missing.catch(() => undefined);
		valid.catch(() => undefined);
		try {
			const denial = await callbackRequest(
				callback.redirectUrl,
				"/callback?state=denied-state&error=access_denied&error_description=Denied",
			);
			expect(denial.status).toBe(200);
			expect(denial.body).toContain("Denied");
			await expect(denied).rejects.toThrow("Denied");
			expect((await callbackRequest(callback.redirectUrl, "/callback?state=missing-state")).status).toBe(400);
			await expect(missing).rejects.toThrow("OAuth callback did not include an authorization code");
			expect((await callbackRequest(callback.redirectUrl, "/callback?state=valid-state&code=good")).status).toBe(
				200,
			);
			await expect(valid).resolves.toEqual({ code: "good", state: "valid-state" });
		} finally {
			await callback.close();
		}
	});

	// smarty-dev#2241 F7 countercase: owner close must still reject pending callbacks and release the listener.
	it("rejects pending callbacks on close and stops accepting HTTP", async () => {
		const callback = await OAuthCallbackServer.listen();
		const pending = callback.waitForCallback("expected-state");
		pending.catch(() => undefined);
		await callback.close();
		await expect(pending).rejects.toThrow("OAuth callback server closed");
		await expect(
			callbackRequest(callback.redirectUrl, "/callback?state=expected-state&code=late"),
		).rejects.toMatchObject({
			code: "ECONNREFUSED",
		});
	});
});
