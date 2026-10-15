import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			globals: true,
			environment: "node",
			// Forge has two vCPUs; Vitest's default reserves one and serializes all files.
			// Keep local worker selection unchanged and retain per-file isolation in CI.
			maxWorkers: process.env.CI ? 2 : undefined,
			testTimeout: 30000,
			// Tests run offline by default; opt in with allowNetwork() from test/test-network-env.ts.
			env: { PI_OFFLINE: "1" },
			unstubEnvs: true,
			reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
			silent: "passed-only",
			server: {
				deps: {
					external: [/@silvia-odwyer\/photon-node/],
				},
			},
		},
		resolve: {
			alias: [
				{
					find: /^@earendil-works\/pi-durable$/,
					replacement: fileURLToPath(new URL("../durable/src/index.ts", import.meta.url)),
				},
				{
					find: /^@earendil-works\/pi-durable\/env\/node$/,
					replacement: fileURLToPath(new URL("../durable/src/env/node.ts", import.meta.url)),
				},
				{
					find: /^@earendil-works\/pi-durable\/tools$/,
					replacement: fileURLToPath(new URL("../durable/src/tools/index.ts", import.meta.url)),
				},
				{
					find: /^@earendil-works\/pi-durable\/storage\/sqlite\/node$/,
					replacement: fileURLToPath(new URL("../durable/src/storage/sqlite/node.ts", import.meta.url)),
				},
				{ find: /^@earendil-works\/pi-ai$/, replacement: workspaceSourcePaths.aiIndex },
				{ find: /^@earendil-works\/pi-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
				{ find: /^@mariozechner\/pi-ai$/, replacement: workspaceSourcePaths.aiIndex },
				{ find: /^@mariozechner\/pi-ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
				{ find: /^@mariozechner\/pi-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
				{ find: /^@mariozechner\/pi-tui$/, replacement: workspaceSourcePaths.tuiIndex },
			],
		},
	}),
);
