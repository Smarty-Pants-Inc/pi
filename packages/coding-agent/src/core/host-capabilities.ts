/** Read capabilities from pi.hostCapabilities, not an extension's bundled package copy. */
export const HOST_CAPABILITIES = Object.freeze({
	/** Triggered custom messages wait behind an admitted prompt's preflight. */
	triggeredMessageQueuesBehindPreflight: true as boolean,
	/** Synchronous input accounting and fail-closed replacement/disposal fences. */
	inputAdmission: 1,
	/** ctx.isPromptPending() reports user input awaiting handoff. */
	promptPendingVisible: true as boolean,
	/** Emitted immediately before the built-in bash executor runs. */
	bashSpawnEvent: true as boolean,
	/** Transforms partial snapshots before all tool update consumers. */
	toolPartialResult: true as boolean,
});

export type HostCapabilities = typeof HOST_CAPABILITIES;
