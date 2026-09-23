import { defineConfig, mergeConfig } from "vitest/config";
import packageConfig from "../vitest.config.ts";

// Explicit target for the migrated legacy .node.ts filename. MOCK dependencies
// require Vitest isolation; this is not a direct node:test/native qualification.
export default mergeConfig(
	packageConfig,
	defineConfig({
		test: {
			include: ["test/ordinary-sc085-setup.node.ts"],
			isolate: true,
		},
	}),
);
