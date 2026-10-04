import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const durableSrcIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));
const durableSrcTesting = fileURLToPath(new URL("./src/testing/index.ts", import.meta.url));

export default defineConfig({
	test: {
		environment: "node",
		// Reopen conformance performs thousands of disk commits, also under low-priority CI load.
		testTimeout: 30_000,
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
