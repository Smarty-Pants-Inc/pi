import type { Component, TUI } from "../tui.ts";
import { Text } from "./text.ts";

export interface LoaderIndicatorOptions {
	/** Animation frames. Use an empty array to hide the indicator. */
	frames?: string[];
	/** Frame interval in milliseconds for animated indicators. */
	intervalMs?: number;
}

const DEFAULT_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DEFAULT_INTERVAL_MS = 80;
const IDLE_AFTER_MS = 10_000;
const IDLE_INTERVAL_MS = 1000;

/** Loader component that animates locally and slows down while waiting for output. */
export class Loader extends Text {
	private frames = [...DEFAULT_FRAMES];
	private intervalMs = DEFAULT_INTERVAL_MS;
	private currentFrame = 0;
	private intervalId: NodeJS.Timeout | null = null;
	private ui: TUI;
	private animationTarget: Component = this;
	private unsubscribeActivity?: () => void;
	private lastActivityAt = Date.now();
	private renderIndicatorVerbatim = false;
	private spinnerColorFn: (str: string) => string;
	private messageColorFn: (str: string) => string;
	private message: string = "Loading...";

	constructor(
		ui: TUI,
		spinnerColorFn: (str: string) => string,
		messageColorFn: (str: string) => string,
		message: string = "Loading...",
		indicator?: LoaderIndicatorOptions,
	) {
		super("", 1, 0);
		this.ui = ui;
		this.spinnerColorFn = spinnerColorFn;
		this.messageColorFn = messageColorFn;
		this.message = message;
		this.setIndicator(indicator);
	}

	render(width: number): string[] {
		return ["", ...super.render(width)];
	}

	start(): void {
		this.stop();
		this.lastActivityAt = Date.now();
		this.updateDisplay();
		if (this.frames.length <= 1) return;
		this.unsubscribeActivity = this.ui.onActivity?.(() => {
			const wasIdle = Date.now() - this.lastActivityAt >= IDLE_AFTER_MS;
			this.lastActivityAt = Date.now();
			if (wasIdle) {
				if (this.intervalId) clearTimeout(this.intervalId);
				this.restartAnimation();
			}
		});
		this.restartAnimation();
	}

	stop(): void {
		if (this.intervalId) {
			clearTimeout(this.intervalId);
			this.intervalId = null;
		}
		this.unsubscribeActivity?.();
		this.unsubscribeActivity = undefined;
	}

	/** Redirect animation redraws when another component embeds this loader (for example, an editor border). */
	setAnimationTarget(component?: Component): void {
		this.animationTarget = component ?? this;
	}

	setMessage(message: string): void {
		this.message = message;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay(true);
	}

	setIndicator(indicator?: LoaderIndicatorOptions): void {
		this.renderIndicatorVerbatim = indicator !== undefined;
		this.frames = indicator?.frames !== undefined ? [...indicator.frames] : [...DEFAULT_FRAMES];
		this.intervalMs = indicator?.intervalMs && indicator.intervalMs > 0 ? indicator.intervalMs : DEFAULT_INTERVAL_MS;
		this.currentFrame = 0;
		this.start();
	}

	private restartAnimation(): void {
		const idle = Date.now() - this.lastActivityAt >= IDLE_AFTER_MS;
		this.intervalId = setTimeout(
			() => {
				this.currentFrame = (this.currentFrame + 1) % this.frames.length;
				this.updateDisplay(true);
				this.restartAnimation();
			},
			idle ? Math.max(this.intervalMs, IDLE_INTERVAL_MS) : this.intervalMs,
		);
	}

	protected getRenderedIndicator(): string {
		const frame = this.frames[this.currentFrame] ?? "";
		return this.renderIndicatorVerbatim ? frame : this.spinnerColorFn(frame);
	}

	private updateDisplay(animation = false): void {
		const renderedFrame = this.getRenderedIndicator();
		const indicator = renderedFrame.length > 0 ? `${renderedFrame} ` : "";
		this.setText(`${indicator}${this.messageColorFn(this.message)}`);
		if (animation && this.ui.requestAnimationRender) this.ui.requestAnimationRender(this.animationTarget);
		else this.ui.requestRender(false, animation);
	}
}
