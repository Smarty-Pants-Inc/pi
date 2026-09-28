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
});

export type HostCapabilities = typeof HOST_CAPABILITIES;
