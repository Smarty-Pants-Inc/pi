/**
 * Enroll as Herdr's input consumer at interactive startup, before any extension loads (smarty-dev#2636).
 *
 * Pi sets raw mode first (Herdr requires it at enroll), holds stdin bytes while enrolling, and waits
 * up to 2 s for the marker. Held bytes are handed to the TUI's terminal through the meter, so nothing
 * typed during startup is lost. Any failed precondition means no epoch: every turn stays `terminal`.
 */
import { readFileSync } from "node:fs";
import type { InputByteMeter } from "@earendil-works/pi-tui";
import { EpochByteCounter, type PushResult } from "./epoch-bytes.ts";
import { enrollHerdrInputConsumer } from "./input-consumer.ts";
import { loadServerTrustRoot } from "./server-auth.ts";
import { SubmitAttestor } from "./submit-attestor.ts";

const MARKER_WAIT_MS = 2000;

export interface HerdrInputBootstrap {
	/** Attach to the interactive TUI's terminal before it starts reading. */
	readonly meter: InputByteMeter;
	/** Undefined when enrollment failed: held input is still replayed, but nothing is attested. */
	readonly attestor?: SubmitAttestor;
	/** Call synchronously right before the TUI's terminal starts: it restores the pre-Pi tty mode. */
	handOff(): void;
}

function sysctl(path: string): number | undefined {
	try {
		return Number.parseInt(readFileSync(path, "utf8").trim(), 10);
	} catch {
		return undefined;
	}
}

/** Same-uid processes must not be able to inject input (TIOCSTI) or attach to Herdr (ptrace). */
function preconditionsHold(): boolean {
	return sysctl("/proc/sys/dev/tty/legacy_tiocsti") === 0 && (sysctl("/proc/sys/kernel/yama/ptrace_scope") ?? 0) >= 1;
}

function concat(parts: PushResult[]): PushResult {
	const epochParts = parts.filter((part) => part.epoch.length);
	return {
		preEpoch: Buffer.concat(parts.map((part) => part.preEpoch)),
		epoch: Buffer.concat(epochParts.map((part) => part.epoch)),
		epochStart: epochParts[0]?.epochStart ?? 0,
	};
}

export async function startHerdrInputConsumer(
	env: NodeJS.ProcessEnv = process.env,
): Promise<HerdrInputBootstrap | undefined> {
	const socketPath = env.HERDR_SOCKET_PATH;
	const paneId = env.HERDR_PANE_ID;
	const stdin = process.stdin;
	if (process.platform !== "linux" || !socketPath || !paneId || !stdin.isTTY || !preconditionsHold()) return undefined;
	const trustRoot = loadServerTrustRoot();
	if (!trustRoot) return undefined;

	const wasRaw = stdin.isRaw;
	stdin.setRawMode(true);
	const counter = new EpochByteCounter();
	counter.hold();
	const pending: PushResult[] = [];
	let markerSeen: () => void = () => {};
	const onData = (chunk: Buffer | string) => {
		pending.push(counter.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk));
		if (counter.active) markerSeen();
	};
	stdin.on("data", onData);
	stdin.resume();

	const enrolled = await enrollHerdrInputConsumer({ socketPath, paneId, trustRoot, timeoutMs: MARKER_WAIT_MS });
	if (enrolled.ok) {
		pending.push(counter.arm(enrolled.epoch.nonce));
		if (!counter.active) {
			await new Promise<void>((resolve) => {
				markerSeen = resolve;
				setTimeout(resolve, MARKER_WAIT_MS);
			});
		}
	}
	stdin.off("data", onData);
	stdin.pause();
	if (!enrolled.ok || !counter.active) {
		if (enrolled.ok) enrolled.epoch.release();
		pending.push(counter.abandon());
		stdin.setRawMode(wasRaw);
		// Keep what was typed during enrollment: the TUI replays it as ordinary input.
		return {
			meter: { push: (chunk) => counter.push(chunk), takePending: () => concat(pending.splice(0)), end: () => {} },
			handOff: () => {},
		};
	}
	const epoch = enrolled.epoch;
	return {
		meter: {
			push: (chunk) => counter.push(chunk),
			takePending: () => concat(pending.splice(0)),
			end: () => {
				counter.end();
				epoch.release();
			},
		},
		attestor: new SubmitAttestor(counter, epoch),
		handOff: () => stdin.setRawMode(wasRaw),
	};
}
