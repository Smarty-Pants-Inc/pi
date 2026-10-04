/** Shared/exclusive admission for direct and nested tool pipelines. */
export interface ToolCallAdmission {
	id: string;
	parentId?: string;
	exclusive: boolean;
	signal?: AbortSignal;
}

interface WaitingCall extends ToolCallAdmission {
	resolve: (release: () => void) => void;
	reject: (error: unknown) => void;
	removeAbort: () => void;
}

export class ToolCallQueue {
	private readonly active = new Map<string, ToolCallAdmission>();
	private readonly waiting: WaitingCall[] = [];

	has(id: string): boolean {
		return this.active.has(id);
	}

	async run<T>(admission: ToolCallAdmission, execute: () => Promise<T>): Promise<T> {
		const release = await this.acquire(admission);
		try {
			admission.signal?.throwIfAborted();
			return await execute();
		} finally {
			release();
		}
	}

	private acquire(admission: ToolCallAdmission): Promise<() => void> {
		if (admission.signal?.aborted) return Promise.reject(admission.signal.reason);
		if (this.active.has(admission.id) || this.waiting.some((call) => call.id === admission.id)) {
			return Promise.reject(new Error("TOOL_CALL_ID_ALREADY_ACTIVE"));
		}
		return new Promise((resolve, reject) => {
			const call: WaitingCall = { ...admission, resolve, reject, removeAbort: () => {} };
			const abort = () => {
				const index = this.waiting.indexOf(call);
				if (index < 0) return;
				this.waiting.splice(index, 1);
				call.removeAbort();
				reject(admission.signal?.reason);
				this.pump();
			};
			admission.signal?.addEventListener("abort", abort, { once: true });
			call.removeAbort = () => admission.signal?.removeEventListener("abort", abort);
			this.waiting.push(call);
			this.pump();
		});
	}

	private pump(): void {
		for (let index = 0; index < this.waiting.length; ) {
			const call = this.waiting[index];
			const ancestors = new Set<string>();
			let parentId = call.parentId;
			let sharedAncestor = false;
			let retired = false;
			while (parentId) {
				const parent = this.active.get(parentId);
				if (!parent) {
					retired = true;
					break;
				}
				ancestors.add(parentId);
				sharedAncestor ||= !parent.exclusive;
				parentId = parent.parentId;
			}
			const blocked = [...this.active.values()].some(
				(active) => !ancestors.has(active.id) && (call.exclusive || active.exclusive),
			);
			// Waiting to upgrade a shared ancestor can self-deadlock against another
			// family doing the same. Refuse only conflicting upgrades; callers that
			// require exclusive descendants must declare the orchestrator sequential.
			if (retired || (call.exclusive && sharedAncestor && blocked)) {
				this.waiting.splice(index, 1);
				call.removeAbort();
				call.reject(new Error(retired ? "PARENT_TOOL_CALL_RETIRED" : "TOOL_QUEUE_CONFLICTING_REENTRY"));
				continue;
			}
			// Descendants must be able to finish an active ancestor ahead of unrelated
			// queued roots. Otherwise an exclusive root waiting on that ancestor deadlocks it.
			const olderRoot =
				!call.parentId &&
				this.waiting.slice(0, index).some((older) => !older.parentId && (older.exclusive || call.exclusive));
			if (blocked || olderRoot) {
				index++;
				continue;
			}
			this.waiting.splice(index, 1);
			call.removeAbort();
			this.active.set(call.id, call);
			call.resolve(() => {
				if (this.active.get(call.id) !== call) return;
				this.active.delete(call.id);
				this.pump();
			});
		}
	}
}
