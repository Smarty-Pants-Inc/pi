export class OAuthError extends Error {
	readonly code: string;
	readonly errorUri: string | undefined;

	constructor(code: string, message: string, errorUri?: string) {
		super(message || code);
		this.name = "OAuthError";
		this.code = code;
		this.errorUri = errorUri;
	}
}

export class OAuthIssuerMismatchError extends Error {
	readonly expected: string;
	/** `undefined` when an authorization response lacks the `iss` parameter its server promised (RFC 9207). */
	readonly received: string | undefined;

	constructor(expected: string, received: string | undefined) {
		super(
			`OAuth issuer mismatch: expected ${JSON.stringify(expected)}, received ${received === undefined ? "none" : JSON.stringify(received)}`,
		);
		this.name = "OAuthIssuerMismatchError";
		this.expected = expected;
		this.received = received;
	}
}

/** Protected resource metadata names a resource other than the MCP server it was discovered for (RFC 9728 §3.3). */
export class OAuthResourceMismatchError extends Error {
	readonly expected: string;
	readonly received: string;

	constructor(expected: string, received: string) {
		super(`Protected resource ${received} does not match MCP server ${expected}`);
		this.name = "OAuthResourceMismatchError";
		this.expected = expected;
		this.received = received;
	}
}

export class OAuthInsecureEndpointError extends Error {
	readonly endpoint: string;

	constructor(endpoint: string) {
		super(`Refusing to send OAuth credentials to non-HTTPS endpoint ${endpoint}`);
		this.name = "OAuthInsecureEndpointError";
		this.endpoint = endpoint;
	}
}

export class OAuthRedirectRefusedError extends Error {
	readonly endpoint: string;
	readonly status: number;

	constructor(endpoint: string, status: number, reason: string) {
		super(`Refusing OAuth redirect from ${endpoint} (HTTP ${status}): ${reason}`);
		this.name = "OAuthRedirectRefusedError";
		this.endpoint = endpoint;
		this.status = status;
	}
}

export class OAuthRegistrationError extends Error {
	readonly status: number;
	readonly body: string;

	constructor(status: number, body: string) {
		super(`OAuth dynamic client registration failed with status ${status}: ${body}`);
		this.name = "OAuthRegistrationError";
		this.status = status;
		this.body = body;
	}
}

export class McpOAuthAuthorizationRequiredError extends Error {
	constructor() {
		super("MCP OAuth authorization requires user interaction");
		this.name = "McpOAuthAuthorizationRequiredError";
	}
}
