import { describe, expect, it } from "vitest";
import { getTurnProvenance } from "../src/core/turn-provenance.ts";

const receipt = {
	v: 1,
	turnId: "550e8400-e29b-41d4-a716-446655440000",
	receivedAt: "2026-10-03T12:34:56.789Z",
	channel: "terminal",
};
const entry = (provenance: unknown) => ({ type: "message", message: { role: "user" }, provenance });

// smarty-dev#3482/#2636: detached reads preserve data, not trust in an edited session file.
describe("turn provenance detached reader", () => {
	it.each([
		{ ...receipt, channel: "keyboard", principal: { id: "paul", binding: "herdr-client" } },
		{ ...receipt, channel: "voice", principal: { id: "kate", binding: "voice-call" } },
	])("detaches the principal and top-level record: %j", (value) => {
		const input = entry(value);
		const first = getTurnProvenance(input)!;
		const second = getTurnProvenance(input)!;
		expect(first).toStrictEqual(value);
		expect(first).not.toBe(value);
		expect(first.principal).not.toBe(value.principal);
		expect(second).not.toBe(first);
		expect(second.principal).not.toBe(first.principal);
		first.receivedAt = "2000-01-01T00:00:00.000Z";
		first.principal!.id = "edited-output";
		expect(value.principal.id).not.toBe("edited-output");
		value.principal.id = "edited-input";
		expect(second.principal!.id).not.toBe("edited-input");
		expect(getTurnProvenance(input)?.principal?.id).toBe("edited-input");
	});

	it("detaches sender fields and reads schema-valid hand-edited JSON without authenticating it", () => {
		const input = JSON.parse(
			JSON.stringify(
				entry({
					...receipt,
					channel: "fabric",
					via: "replay",
					submissionToken: "reserved",
					sender: { id: "forged-on-disk", kind: "remote", name: "Paul", verified: "bridge" },
				}),
			),
		) as { provenance: { sender: { id: string; name: string } } };
		const first = getTurnProvenance(input)!;
		const second = getTurnProvenance(input)!;
		expect(first.sender).not.toBe(input.provenance.sender);
		expect(first.sender).not.toBe(second.sender);
		expect(first.sender?.verified).toBe("bridge");
		first.sender!.id = "edited-output";
		input.provenance.sender.name = "edited-input";
		expect(second.sender?.id).toBe("forged-on-disk");
		expect(second.sender?.name).toBe("Paul");
		expect(getTurnProvenance(input)?.sender?.name).toBe("edited-input");
	});

	it("copies only allowed fields without spreading unknown nested data", () => {
		const keyboard = { ...receipt, channel: "keyboard", principal: { id: "paul", binding: "herdr-client" } };
		const fabric = { ...receipt, channel: "fabric", sender: { id: "worker", kind: "agent", verified: "mesh" } };
		const ignored = { authoritative: true, secret: { nested: "ignored" } };
		expect(
			getTurnProvenance(entry({ ...keyboard, ...ignored, principal: { ...keyboard.principal, ...ignored } })),
		).toStrictEqual(keyboard);
		expect(
			getTurnProvenance(entry({ ...fabric, ...ignored, sender: { ...fabric.sender, ...ignored } })),
		).toStrictEqual(fabric);
		expect(getTurnProvenance(entry({ ...receipt, ...ignored }))).toStrictEqual(receipt);
	});

	it("does not mutate or freeze input records", () => {
		const principal = Object.freeze({ id: "paul", binding: "herdr-client" });
		const provenance = Object.freeze({ ...receipt, channel: "keyboard", principal });
		const input = Object.freeze(entry(provenance));
		expect(getTurnProvenance(input)).toStrictEqual(provenance);
		const mutable = entry({ ...receipt });
		getTurnProvenance(mutable);
		expect(Object.isFrozen(mutable.provenance)).toBe(false);
	});

	it("returns UNKNOWN rather than throwing for unreadable fields", () => {
		const unreadable = Object.defineProperty({}, "provenance", {
			get() {
				throw new Error("unreadable");
			},
		});
		expect(getTurnProvenance(Object.assign(unreadable, { type: "custom_message" }))).toBeUndefined();
		const revoked = Proxy.revocable({}, {});
		revoked.revoke();
		expect(getTurnProvenance(revoked.proxy)).toBeUndefined();
	});
});
