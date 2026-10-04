import { request } from "node:http";
import { OAuthCallbackServer } from "../../src/oauth/callback.ts";

const callback = await OAuthCallbackServer.listen({ timeoutMs: 3000 });
const pending = callback.waitForCallback("pending");
pending.catch(() => undefined);
try {
	const url = new URL(callback.redirectUrl);
	const malformedStatus = await new Promise((resolve, reject) => {
		const req = request({ hostname: url.hostname, port: url.port, path: "//[" }, (response) => {
			response.resume();
			response.once("end", () => resolve(response.statusCode));
		});
		req.once("error", reject);
		req.end();
	});
	const valid = await fetch(`${callback.redirectUrl}?code=abc&state=pending`);
	await valid.text();
	const { code, state } = await pending;
	console.log(JSON.stringify({ malformedStatus, validStatus: valid.status, code, state }));
} finally {
	await callback.close();
}
