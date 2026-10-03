/** Credential response bodies and parser/stream errors must never become login diagnostics. */
export async function readOAuthCredentialResponse(response: Response, operation: string): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		throw new Error(`${operation} response is invalid JSON`);
	}
}
