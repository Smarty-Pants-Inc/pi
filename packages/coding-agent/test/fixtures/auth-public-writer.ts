import { writeFileSync } from "node:fs";
import { AuthStorage } from "../../src/core/auth-storage.ts";

const [authPath, startedPath, savedPath] = process.argv.slice(2);
const storage = AuthStorage.create(authPath);
writeFileSync(startedPath, "started");
const grant = { type: "oauth" as const, access: "fake-access", refresh: "fake-refresh", expires: 12345 };
await storage.modify("fake-provider", async () => grant);
if (JSON.stringify(await storage.read("fake-provider")) !== JSON.stringify(grant)) {
	throw new Error("Public writer did not read its saved grant");
}
writeFileSync(savedPath, "saved");
