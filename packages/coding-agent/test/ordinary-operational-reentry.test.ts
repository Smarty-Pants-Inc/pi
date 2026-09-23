import { createHash } from "node:crypto";
import { expect, test, vi } from "vitest";
import {
	createOperationalAdmission,
	type HeldOperationalRecord,
} from "../src/core/ordinary-sc085-source/operational-admission.ts";

const helper = vi.hoisted(() =>
	vi.fn(() => {
		throw new Error("unexpected CI helper invocation");
	}),
);
vi.mock("../src/core/ordinary-sc085-source/ci-authority.ts", () => ({
	receiveOriginalCIAuthorization: helper,
	assertOriginalCINativeBinding: vi.fn(),
	canonicalOriginalCIData: vi.fn(),
	OPERATIONAL_CONTROLLER_SHA256: "0".repeat(64),
}));

// Inert malformed data intentionally cannot reach CI or native admission. The
// original held-file callback must refuse reentry BEFORE parsing or helper I/O.
test.each([false, true])(
	"original held callback reentry is bounded, sticky and preserves cause (swallowed=%s)",
	(swallowed) => {
		helper.mockClear();
		const raw = Buffer.from("{}");
		let armed = false,
			checks = 0;
		let supplier: ReturnType<typeof createOperationalAdmission>;
		const ref = { path: "/synthetic/held", sha256: createHash("sha256").update(raw).digest("hex") };
		const held: HeldOperationalRecord = {
			ref,
			held: {
				bytes: raw,
				close() {},
				check() {
					if (!armed) return;
					if (++checks > 8) throw new Error("fixture recursive sentinel");
					if (swallowed) {
						try {
							supplier.check("boundary");
						} catch {
							/* Hostile swallowed error. */
						}
					} else supplier.check("boundary");
				},
			},
		};
		supplier = createOperationalAdmission({
			instruction: held,
			producerContract: held,
			profile: held,
			decision: held,
			receiving: held,
			producers: new Map(),
			retained: new Map([[ref.path, raw]]),
		});
		armed = true;
		let first: unknown;
		try {
			supplier.check("boundary");
		} catch (error) {
			first = error;
		}
		expect(first).toBeInstanceOf(Error);
		expect((first as Error).message).toBe("OPS_SYNCHRONOUS_AUTHORITY_REENTRY");
		expect(checks).toBe(swallowed ? 2 : 1);
		const previous = checks;
		for (const action of [() => supplier.check("boundary"), () => supplier.receiveFdSlotPreflight()]) {
			try {
				action();
				expect.fail("sticky failure expected");
			} catch (error) {
				expect(error).toBe(first);
			}
		}
		expect(checks).toBe(previous);
		expect(helper).not.toHaveBeenCalled();
	},
);
