export const TURN_PROVENANCE_VERSION = 1;

export type TurnChannel = "terminal" | "keyboard" | "voice" | "fabric";
export type TurnSenderKind = "main" | "actor" | "agent" | "remote";
export type TurnFabricVia = "steer" | "followUp" | "actor" | "replay";

export interface TurnPrincipal {
	id: string;
	binding: "herdr-client" | "voice-call";
}

export interface TurnSender {
	id: string;
	kind: TurnSenderKind;
	name?: string;
	verified: "mesh" | "bridge";
}

interface TurnProvenanceBase {
	v: typeof TURN_PROVENANCE_VERSION;
	turnId: string;
	receivedAt: string;
	/** Reserved opaque correlation data; never proof of identity. */
	submissionToken?: string;
}

export type TurnProvenance = TurnProvenanceBase &
	(
		| { channel: "terminal"; principal?: never; sender?: never; via?: never }
		| { channel: "keyboard"; principal: { id: string; binding: "herdr-client" }; sender?: never; via?: never }
		| { channel: "voice"; principal: { id: string; binding: "voice-call" }; sender?: never; via?: never }
		| { channel: "fabric"; principal?: never; sender: TurnSender; via?: TurnFabricVia }
	);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown): value is string {
	return typeof value === "string" && value.length <= 200 && value.trim().length > 0;
}

/**
 * Read only entry-level user/custom provenance, copying allowed fields into a detached record.
 * Undefined means UNKNOWN. Schema validity does not authenticate hand-edited session data;
 * a terminal receipt also means UNKNOWN to attribution consumers. This reader enables no ingress.
 */
export function getTurnProvenance(entry: unknown): TurnProvenance | undefined {
	try {
		if (!isRecord(entry)) return undefined;
		const { type, message, provenance } = entry;
		if (
			type !== "custom_message" &&
			!(type === "message" && isRecord(message) && (message.role === "user" || message.role === "custom"))
		)
			return undefined;
		if (!isRecord(provenance)) return undefined;
		const { v, turnId, receivedAt, channel, principal, sender, via, submissionToken } = provenance;
		if (
			v !== TURN_PROVENANCE_VERSION ||
			typeof turnId !== "string" ||
			turnId.length !== 36 ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(turnId) ||
			!isBoundedString(receivedAt) ||
			receivedAt.length !== 24
		)
			return undefined;
		const date = new Date(receivedAt);
		if (!Number.isFinite(date.getTime()) || date.toISOString() !== receivedAt) return undefined;
		const base: TurnProvenanceBase = { v: TURN_PROVENANCE_VERSION, turnId, receivedAt };
		if ("submissionToken" in provenance) {
			if (!isBoundedString(submissionToken)) return undefined;
			base.submissionToken = submissionToken;
		}

		if (channel === "terminal") {
			if ("principal" in provenance || "sender" in provenance || "via" in provenance) return undefined;
			return { ...base, channel };
		}
		if (channel === "keyboard" || channel === "voice") {
			if ("sender" in provenance || "via" in provenance || !isRecord(principal)) return undefined;
			const { id, binding } = principal;
			if (!isBoundedString(id)) return undefined;
			if (channel === "keyboard" && binding === "herdr-client")
				return { ...base, channel, principal: { id, binding } };
			if (channel === "voice" && binding === "voice-call") return { ...base, channel, principal: { id, binding } };
			return undefined;
		}
		if (channel !== "fabric" || "principal" in provenance || !isRecord(sender)) return undefined;
		const { id, kind, verified, name } = sender;
		if (
			!isBoundedString(id) ||
			(kind !== "main" && kind !== "actor" && kind !== "agent" && kind !== "remote") ||
			(verified !== "mesh" && verified !== "bridge")
		)
			return undefined;
		const result: Extract<TurnProvenance, { channel: "fabric" }> = {
			...base,
			channel,
			sender: { id, kind, verified },
		};
		if ("name" in sender) {
			if (!isBoundedString(name)) return undefined;
			result.sender.name = name;
		}
		if ("via" in provenance) {
			if (via !== "steer" && via !== "followUp" && via !== "actor" && via !== "replay") return undefined;
			result.via = via;
		}
		return result;
	} catch {
		return undefined;
	}
}
