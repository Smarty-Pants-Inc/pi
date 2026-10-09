/**
 * Reusable countdown timer for dialog components.
 */

import type { TUI } from "@earendil-works/pi-tui";

export class CountdownTimer {
	private intervalId: ReturnType<typeof setInterval> | undefined;
	private expiryTimer: ReturnType<typeof setTimeout> | undefined;
	private unsubscribeVisibility?: () => void;
	private remainingSeconds: number;
	private deadline: number;
	private tui: TUI | undefined;
	private onTick: (seconds: number) => void;
	private onExpire: () => void;

	constructor(timeoutMs: number, tui: TUI | undefined, onTick: (seconds: number) => void, onExpire: () => void) {
		this.tui = tui;
		this.onTick = onTick;
		this.onExpire = onExpire;
		this.remainingSeconds = Math.ceil(timeoutMs / 1000);
		this.deadline = Date.now() + this.remainingSeconds * 1000;
		this.onTick(this.remainingSeconds);
		// The functional deadline still expires while hidden; only cosmetic ticks pause.
		this.expiryTimer = setTimeout(() => {
			this.remainingSeconds = 0;
			this.onTick(0);
			this.tui?.requestRender();
			this.dispose();
			this.onExpire();
		}, this.remainingSeconds * 1000);
		if (tui) {
			this.unsubscribeVisibility = tui.onVisibilityChange((visible) => {
				this.pauseTicks();
				if (visible) this.startTicks();
			});
		} else {
			this.startTicks();
		}
	}

	private startTicks(): void {
		this.updateRemaining();
		this.intervalId = setInterval(() => this.updateRemaining(), 1000);
	}

	private updateRemaining(): void {
		const seconds = Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000));
		if (seconds === this.remainingSeconds) return;
		this.remainingSeconds = seconds;
		this.onTick(seconds);
		this.tui?.requestRender();
	}

	private pauseTicks(): void {
		if (this.intervalId) clearInterval(this.intervalId);
		this.intervalId = undefined;
	}

	dispose(): void {
		this.pauseTicks();
		clearTimeout(this.expiryTimer);
		this.expiryTimer = undefined;
		this.unsubscribeVisibility?.();
		this.unsubscribeVisibility = undefined;
	}
}
