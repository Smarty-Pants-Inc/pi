import { ModelRuntime } from "../core/model-runtime.ts";
import { SettingsManager } from "../core/settings-manager.ts";

/** Bind Harness requests to the target project's policy, not the host process cwd. */
export async function createHarnessModelRuntime(
	cwd: string,
): Promise<{ modelRuntime: ModelRuntime; settingsManager: SettingsManager }> {
	const settingsManager = SettingsManager.create(cwd);
	const modelRuntime = await ModelRuntime.create({ settingsManager });
	return { modelRuntime, settingsManager };
}
