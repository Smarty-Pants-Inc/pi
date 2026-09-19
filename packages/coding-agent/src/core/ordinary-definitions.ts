import { createHash } from "node:crypto";
import { isAbsolute, join, normalize } from "node:path";
import { assertOrdinaryOwner, type OrdinaryOwnerContext } from "./ordinary-owner-context.ts";
import type { OwnedTreeFile, OwnedTreeLimits } from "./owner-effects.ts";

/** Private structural ports for the single descriptor-pinned common entry. */
export interface OrdinarySenseScope {
	harness: "pi";
	tenantId: string;
	principalId: string;
	sessionId: string;
	branchId: string;
	workspaceDir: string;
}

interface PackageFile {
	path: string;
	mode: number;
	bytes: Uint8Array;
}

interface Definition {
	source: string;
	revision: string;
	packageDir: string;
	run: readonly string[];
}

interface Approval {
	readonly source: string;
	readonly revision: string;
	readonly snapshotDir: string;
	readonly policyId: string;
	readonly runtimeId: string;
	readonly run: readonly string[];
}

function closureRevision(files: readonly PackageFile[]): string {
	// FileDefinitions hashes canonical JSON with alphabetically ordered object
	// keys. This fixed record shape needs no second general canonicalizer.
	return createHash("sha256")
		.update(
			JSON.stringify(
				files.map((file) => ({
					hash: createHash("sha256").update(file.bytes).digest("hex"),
					mode: file.mode,
					path: file.path,
				})),
			),
		)
		.digest("hex");
}

/** The common registry keeps parsing, revision adoption and caching. Only its
 * existing IO and authorize ports receive these captured-owner implementations. */
export function createOrdinaryDefinitionPorts(context: OrdinaryOwnerContext, originalScope: OrdinarySenseScope) {
	assertOrdinaryOwner(context);
	const owner = context.owner;
	const scope = Object.freeze({ ...originalScope });
	const record = context.decision.record;
	if (
		scope.harness !== "pi" ||
		scope.tenantId !== record.admission.owner.tenantId ||
		scope.principalId !== record.admission.owner.principalId ||
		scope.sessionId !== owner.manager.getSessionId() ||
		scope.workspaceDir !== record.roots.W.path ||
		!scope.branchId
	)
		throw new Error("OWNER_DEFINITION_SCOPE");
	const scopeKey = createHash("sha256")
		.update(
			JSON.stringify({
				branchId: scope.branchId,
				harness: scope.harness,
				principalId: scope.principalId,
				sessionId: scope.sessionId,
				tenantId: scope.tenantId,
				workspaceDir: scope.workspaceDir,
			}),
		)
		.digest("hex");
	const roots = [
		{ id: "project", path: join(record.roots.W.path, ".agents", "senses") },
		{ id: "installed", path: record.roots.D.path },
	];
	const snapshotRoot = join(record.roots.T.path, `ordinary-${owner.grant}`, "snapshots");
	const snapshots = new Set<string>();
	const approvals = new Map<string, Approval>();
	const limits = Object.freeze({
		maxFiles: 256,
		maxBytes: Math.min(4 * 1024 * 1024, owner.host.profile.limits.outputBytes),
		maxDepth: 16,
		maxDefinitions: 256,
	});
	const target = (directory: string) => {
		context.assertActive();
		if (!isAbsolute(directory) || normalize(directory) !== directory) throw new Error("OWNER_DEFINITION_PATH");
		for (const role of ["W", "D", "T"] as const) {
			const root = record.roots[role].path;
			if (directory === root || directory.startsWith(`${root}/`)) {
				return {
					root: context.decision.roots[role],
					relative: directory === root ? "" : directory.slice(root.length + 1),
				};
			}
		}
		throw new Error("OWNER_DEFINITION_PATH");
	};
	const packageRoot = (directory: string) =>
		roots.find(
			(root) =>
				directory.startsWith(`${root.path}/`) &&
				!directory.slice(root.path.length + 1).includes("/") &&
				directory.length > root.path.length + 1,
		);
	const sameScope = (value: OrdinarySenseScope) =>
		Object.keys(scope).every(
			(key) => value[key as keyof OrdinarySenseScope] === scope[key as keyof OrdinarySenseScope],
		);
	const io = Object.freeze({
		async directories(root: string): Promise<string[]> {
			if (!roots.some((candidate) => candidate.path === root)) throw new Error("OWNER_DEFINITION_DISCOVERY");
			const selected = target(root);
			const names = await owner.effect({ kind: "read", root: selected.root }, (effect) =>
				effect.listDirectories(selected.relative),
			);
			context.assertActive();
			return names.sort().map((name) => join(root, name));
		},
		async readClosure(directory: string, requested: OwnedTreeLimits) {
			if (!packageRoot(directory) && !snapshots.has(directory)) throw new Error("OWNER_DEFINITION_CAPTURE");
			if (
				requested.maxFiles !== limits.maxFiles ||
				requested.maxBytes !== limits.maxBytes ||
				requested.maxDepth !== limits.maxDepth
			) {
				throw new Error("OWNER_DEFINITION_LIMIT");
			}
			const selected = target(directory);
			const files = await owner.effect({ kind: "read", root: selected.root }, (effect) =>
				effect.readTree(selected.relative, limits),
			);
			context.assertActive();
			files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
			return { files, revision: closureRevision(files) };
		},
		async createSnapshot(
			root: string,
			key: string,
			revision: string,
			input: readonly PackageFile[],
		): Promise<string> {
			context.assertActive();
			if (root !== snapshotRoot || key !== scopeKey || snapshots.size >= limits.maxDefinitions)
				throw new Error("OWNER_SNAPSHOT_SCOPE");
			const files: OwnedTreeFile[] = input.map(({ path, mode, bytes }) => ({
				path,
				mode,
				bytes: Buffer.from(bytes),
			}));
			files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
			if (closureRevision(files) !== revision) throw new Error("OWNER_SNAPSHOT_REVISION");
			const selected = target(join(root, key));
			const path = await owner.effect({ kind: "write", root: selected.root }, (effect) => {
				const relative = effect.createSnapshot(selected.relative, revision, files);
				const path = join(record.roots.T.path, relative);
				snapshots.add(path);
				return path;
			});
			context.assertActive();
			return path;
		},
		async removeSnapshot(directory: string): Promise<void> {
			context.assertActive();
			if (!snapshots.has(directory)) throw new Error("OWNER_SNAPSHOT_SCOPE");
			const selected = target(directory);
			await owner.effect({ kind: "write", root: selected.root }, (effect) =>
				effect.removeSnapshot(selected.relative),
			);
			snapshots.delete(directory);
			approvals.delete(directory);
			context.assertActive();
		},
	});
	return {
		retained: () => [...snapshots].sort(),
		options: {
			roots,
			snapshotRoot,
			limits,
			io,
			async authorize(
				definition: Definition,
				closure: { revision: string; files: readonly PackageFile[] },
				snapshotDir: string,
				receivedScope: OrdinarySenseScope,
			) {
				context.assertActive();
				const root = packageRoot(definition.packageDir);
				if (
					!sameScope(receivedScope) ||
					!root ||
					!definition.source.startsWith(`${root.id}:`) ||
					!snapshots.has(snapshotDir) ||
					definition.revision !== closure.revision ||
					closureRevision(closure.files) !== closure.revision
				)
					throw new Error("OWNER_DEFINITION_APPROVAL");
				const run = [...definition.run];
				const script = run.length === 2 ? run[1] : run.length === 3 && run[1] === "run" ? run[2] : undefined;
				if (
					run[0] !== "bun" ||
					!script ||
					!/^[a-zA-Z0-9_-][a-zA-Z0-9_./-]*\.ts$/.test(script) ||
					script.split("/").some((part) => part === "." || part === "..") ||
					!closure.files.some((file) => file.path === script)
				) {
					throw new Error("OWNER_DEFINITION_COMMAND");
				}
				const captured = await io.readClosure(snapshotDir, limits);
				context.assertActive();
				if (captured.revision !== definition.revision) throw new Error("OWNER_SNAPSHOT_REVISION");
				const approved = Object.freeze({
					source: definition.source,
					revision: definition.revision,
					snapshotDir,
					policyId: context.decision.digest,
					runtimeId: record.bun.sha256,
					run: Object.freeze(run),
				});
				approvals.set(snapshotDir, approved);
				return { policyId: approved.policyId, runtimeId: approved.runtimeId, run: approved.run };
			},
		},
		approval(snapshotDir: string): Approval {
			context.assertActive();
			const approval = approvals.get(snapshotDir);
			if (!approval) throw new Error("OWNER_DEFINITION_NOT_APPROVED");
			return approval;
		},
	};
}
