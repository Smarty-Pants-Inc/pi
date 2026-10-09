import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import * as root from "../src/index.ts";
import * as oauth from "../src/oauth/index.ts";
import * as testing from "../src/testing/index.ts";

// pi#173 (Astra): these operations trust the metadata they are given. Only authorizeMcp binds the endpoints to
// the issuer origin and allowedEndpointOrigins first, so none of them may be reachable from a package entry.
const internalOperations = [
	"startAuthorization",
	"registerClient",
	"exchangeAuthorizationCode",
	"refreshAuthorization",
] as const;

it.each(internalOperations)("%s is not exported from any package entry", (name) => {
	for (const entry of [root, oauth, testing]) expect(name in entry).toBe(false);
});

it("keeps authorizeMcp as the public OAuth flow entry", () => {
	expect(typeof oauth.authorizeMcp).toBe("function");
});

it("exposes no package subpath that reaches the OAuth flow module", () => {
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
		exports: Record<string, { source: string }>;
	};
	expect(Object.keys(pkg.exports).sort()).toEqual([".", "./oauth", "./testing"]);
	for (const target of Object.values(pkg.exports)) expect(target.source).not.toMatch(/flow/);
});
