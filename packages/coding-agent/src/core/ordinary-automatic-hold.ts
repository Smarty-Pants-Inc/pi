export type OriginalAutomaticEnrollment = (originalRun: () => Promise<void>) => Promise<void>;
type AdmissionResult = "started" | "suppressed";
interface Hold {
	token: object;
	segment: "rapid" | "failures";
	phase: "held" | "released" | "sealed" | "finishing" | "finished";
	check(): void;
	gate: Promise<OriginalAutomaticEnrollment | null>;
	resume(enroll: OriginalAutomaticEnrollment | null): void;
	reject(cause: unknown): void;
	pending?: Promise<AdmissionResult>;
	pendingPeak: number;
	completed: boolean;
}

/** Private original-owner admission wait, not a scheduler or an authority source.
 * Core already awaits this admission and owns its single pending wake intention.
 * No method here calls requestWake or creates a run. */
export class OrdinaryAutomaticHold {
	#hold?: Hold;
	#failure?: { cause: unknown };

	#assertHealthy(): void {
		if (this.#failure) throw this.#failure.cause;
	}

	#check(hold: Hold): void {
		this.#assertHealthy();
		try {
			hold.check();
		} catch (cause) {
			this.fail(cause);
			throw cause;
		}
		this.#assertHealthy();
	}

	#original(token: object): Hold {
		if (this.#failure) throw this.#failure.cause;
		const hold = this.#hold;
		if (!hold || hold.token !== token) throw new Error("OWNER_AUTOMATIC_HOLD_TOKEN");
		this.#check(hold);
		if (this.#hold !== hold) throw new Error("OWNER_AUTOMATIC_HOLD_CHANGED");
		return hold;
	}

	hold(segment: "rapid" | "failures", check: () => void): object {
		if (this.#failure) throw this.#failure.cause;
		if (segment === "rapid" ? this.#hold !== undefined : this.#hold?.phase !== "sealed") {
			throw new Error("OWNER_AUTOMATIC_HOLD_ORDER");
		}
		let resume!: Hold["resume"], reject!: Hold["reject"];
		const gate = new Promise<OriginalAutomaticEnrollment | null>((yes, no) => {
			resume = yes;
			reject = no;
		});
		void gate.catch(() => {});
		const hold: Hold = {
			token: Object.freeze({}),
			segment,
			phase: "held",
			check,
			gate,
			resume,
			reject,
			pendingPeak: 0,
			completed: false,
		};
		this.#hold = hold;
		this.#check(hold);
		return hold.token;
	}

	checkHeld(token: object): void {
		const hold = this.#original(token);
		if (hold.phase !== "held") throw new Error("OWNER_AUTOMATIC_HOLD_NOT_HELD");
	}

	/** Called only by the original context.requestWake, with its original recheck.
	 * The synchronous claim precedes the first await; a second pending caller is
	 * custody loss, not another queued opportunity. */
	admit(invoke: (enroll?: OriginalAutomaticEnrollment) => Promise<AdmissionResult>): Promise<AdmissionResult> {
		if (this.#failure) return Promise.reject(this.#failure.cause);
		const hold = this.#hold;
		if (!hold || hold.phase === "released" || hold.phase === "sealed" || hold.phase === "finished") return invoke();
		try {
			this.#check(hold);
			if (hold.phase !== "held" || hold.pending) throw new Error("OWNER_AUTOMATIC_HOLD_OVERLAP");
			hold.pendingPeak = 1;
			hold.pending = hold.gate
				.then(async (enroll) => {
					this.#check(hold);
					if (enroll === null) return "suppressed";
					const result = await invoke(enroll);
					this.#check(hold);
					if (result !== "started") throw new Error("OWNER_AUTOMATIC_HOLD_SUPPRESSED");
					hold.completed = true;
					return result;
				})
				.catch((cause) => {
					this.fail(cause);
					throw cause;
				});
			void hold.pending.catch(() => {});
			return hold.pending;
		} catch (cause) {
			this.fail(cause);
			return Promise.reject(cause);
		}
	}

	release(token: object, enroll: OriginalAutomaticEnrollment): Promise<AdmissionResult> {
		const hold = this.#original(token);
		if (hold.phase !== "held" || hold.segment !== "rapid" || !hold.pending) {
			throw new Error("OWNER_AUTOMATIC_HOLD_NO_PENDING_ADMISSION");
		}
		hold.phase = "released";
		hold.resume(enroll);
		return hold.pending;
	}

	/** The owning SC085 audit must first prove the actual observation interval. */
	sealed(token: object): void {
		const hold = this.#original(token);
		if (hold.phase !== "released" || !hold.completed) throw new Error("OWNER_AUTOMATIC_HOLD_ORDER");
		hold.phase = "sealed";
	}

	async finishFailures(token: object): Promise<void> {
		const hold = this.#original(token);
		if (hold.phase !== "held" || hold.segment !== "failures") throw new Error("OWNER_AUTOMATIC_HOLD_ORDER");
		hold.phase = "finishing";
		hold.resume(null);
		if (hold.pending) await hold.pending;
		this.#check(hold);
		hold.phase = "finished";
	}

	pendingPeak(token: object): number {
		return this.#original(token).pendingPeak;
	}

	/** Original close/stop owns cancellation. Failure cannot reset or rearm. */
	fail(cause: unknown): void {
		this.#failure ??= { cause };
		this.#hold?.reject(this.#failure.cause);
	}
}
