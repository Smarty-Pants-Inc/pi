import type { Component } from "../tui.ts";
import { truncateToWidth } from "../utils.ts";

const DEFAULT_DURATION_MS = 1000;

interface FlashEntry {
	message: string;
	expiresAt: number;
	timer?: NodeJS.Timeout;
}

/** Transient messages composited by the alternate-screen renderer. */
export class AltScreenFlashContainer implements Component {
	private entries: FlashEntry[] = [];
	private visible = true;
	private readonly requestRender: () => void;

	constructor(requestRender: () => void) {
		this.requestRender = requestRender;
	}

	setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		for (const entry of this.entries) {
			clearTimeout(entry.timer);
			entry.timer = undefined;
		}
		if (visible) {
			this.entries = this.entries.filter((entry) => entry.expiresAt > Date.now());
			for (const entry of this.entries) this.scheduleExpiry(entry);
		}
	}

	flash(message: string, durationMs = DEFAULT_DURATION_MS): void {
		const entry: FlashEntry = { message, expiresAt: Date.now() + Math.max(0, durationMs) };
		this.entries.push(entry);
		if (this.visible) this.scheduleExpiry(entry);
		this.requestRender();
	}

	private scheduleExpiry(entry: FlashEntry): void {
		entry.timer = setTimeout(
			() => {
				const index = this.entries.indexOf(entry);
				if (index === -1) return;
				this.entries.splice(index, 1);
				this.requestRender();
			},
			Math.max(0, entry.expiresAt - Date.now()),
		);
		entry.timer.unref();
	}

	dispose(): void {
		for (const entry of this.entries) clearTimeout(entry.timer);
		this.entries.length = 0;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.entries.map((entry) => {
			const message = truncateToWidth(` ${entry.message} `, width, "");
			return `\x1b[7m${message}\x1b[27m`;
		});
	}
}
