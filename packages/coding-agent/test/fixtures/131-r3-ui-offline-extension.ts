// Private offline fixture for PR #131. No provider API, credential storage, HOME mutation or cleanup.
export const offlineClipboardImage = {
	bytes: new Uint8Array([1, 2, 3]),
	mimeType: "image/png",
};

export function offlineRadiusSession() {
	return {
		model: { provider: "unknown", id: "unknown", api: "unknown" },
		sessionManager: { getCwd: () => process.cwd() },
		settingsManager: { getOrCreateDeviceId: () => "fake-device" },
	};
}
