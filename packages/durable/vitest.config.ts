import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const durableSrcIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));
const durableSrcTesting = fileURLToPath(new URL("./src/testing/index.ts", import.meta.url));

export default defineConfig({
	test: {
		environment: "node",
		// ponytail: storage/compaction cases do real SQLite work; on loaded Forge runners the 5 s default
		// timed out green PRs out of the merge queue (smarty-dev#9281). A hang still fails within 30 s.
		testTimeout: 30_000,
		hookTimeout: 30_000,
		setupFiles: ["./test/setup-document-retention.ts"],
	},
	resolve: {
		conditions: ["source"],
		alias: [
			{ find: /^@earendil-works\/pi-durable$/, replacement: durableSrcIndex },
			{ find: /^@earendil-works\/pi-durable\/testing$/, replacement: durableSrcTesting },
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
});
