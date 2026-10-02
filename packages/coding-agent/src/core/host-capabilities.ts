/**
 * Host behaviors that an extension can detect at runtime. Read them from `pi.hostCapabilities`:
 * an extension package can carry its own copy of this package, whose export describes that copy,
 * not the Pi that runs it.
 */
export const HOST_CAPABILITIES = Object.freeze({
	/**
	 * `sendMessage(..., { triggerTurn: true })` while a prompt is in preflight (input handlers,
	 * `before_agent_start`) waits for that prompt instead of starting a competing run.
	 */
	triggeredMessageQueuesBehindPreflight: true as boolean,
	/** Version 1: synchronous user-input accounting and fail-closed native replacement/disposal fences. */
	inputAdmission: 1,
	/** `ctx.isPromptPending()` reports user input awaiting handoff; such input makes `ctx.isIdle()` false. */
	promptPendingVisible: true as boolean,
});

export type HostCapabilities = typeof HOST_CAPABILITIES;
