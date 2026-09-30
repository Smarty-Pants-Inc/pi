import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it } from "vitest";
import { idFromNumber } from "../src/ids.ts";
import {
	applySqliteMigrations,
	CURRENT_SQLITE_SCHEMA_VERSION,
	SQLITE_MIGRATIONS,
	type SqliteDatabase,
	type SqliteMigration,
} from "../src/storage/sqlite/index.ts";
import { openNodeSqliteDatabase, openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import type {
	ConversationId,
	ConversationRecord,
	EntryId,
	SubmissionId,
	SubmissionRecord,
	TaskId,
} from "../src/types.ts";

// smarty-dev#2241, A8: frozen version 1 statements from the actual released fork
// 81eb324ff488db788ee2215e42c8ea406361287c:packages/durable/src/storage/sqlite/migrations.ts.
// Do not derive this fixture from the current migration: that would hide a rewritten version 1.
const RELEASED_MIGRATIONS: readonly SqliteMigration[] = [
	{
		version: 1,
		statements: [
			`CREATE TABLE durable_metadata (
		singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
		next_id TEXT NOT NULL,
		next_seq INTEGER NOT NULL
	) STRICT`,
			`INSERT INTO durable_metadata (singleton, next_id, next_seq) VALUES (1, '2', 1)`,
			`CREATE TABLE record_ids (
		id INTEGER PRIMARY KEY,
		record_type TEXT NOT NULL CHECK (record_type IN ('conversation', 'entry', 'task', 'submission', 'document'))
	) STRICT`,
			`CREATE TABLE conversations (
		id INTEGER PRIMARY KEY,
		record TEXT NOT NULL CHECK (json_valid(record))
	) STRICT`,
			`CREATE TABLE entries (
		id INTEGER PRIMARY KEY,
		conversation_id INTEGER NOT NULL,
		head INTEGER,
		commit_seq INTEGER NOT NULL,
		record TEXT NOT NULL CHECK (json_valid(record))
	) STRICT`,
			"CREATE INDEX entries_by_conversation ON entries (conversation_id, id DESC)",
			"CREATE INDEX entry_heads_by_conversation ON entries (conversation_id, id DESC) WHERE head IS NOT NULL",
			`CREATE TABLE tasks (
		id INTEGER PRIMARY KEY,
		conversation_id INTEGER NOT NULL,
		kind TEXT NOT NULL,
		status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'terminal')),
		abort_requested INTEGER NOT NULL CHECK (abort_requested IN (0, 1)),
		background INTEGER NOT NULL CHECK (background IN (0, 1)),
		record TEXT NOT NULL CHECK (json_valid(record))
	) STRICT`,
			"CREATE INDEX tasks_by_status ON tasks (status, id)",
			"CREATE INDEX tasks_by_conversation ON tasks (conversation_id, id)",
			"CREATE INDEX tasks_by_kind ON tasks (kind, id)",
			"CREATE INDEX tasks_by_abort_requested ON tasks (abort_requested, id)",
			"CREATE INDEX tasks_by_background ON tasks (background, id)",
			`CREATE TABLE submissions (
		id INTEGER PRIMARY KEY,
		conversation_id INTEGER NOT NULL,
		request_id TEXT,
		record TEXT NOT NULL CHECK (json_valid(record))
	) STRICT`,
			"CREATE INDEX submissions_by_request ON submissions (conversation_id, request_id)",
			`CREATE TABLE documents (
		id INTEGER PRIMARY KEY,
		kind TEXT NOT NULL,
		family INTEGER NOT NULL CHECK (family IN (0, 1)),
		key_value TEXT NOT NULL,
		scope_kind TEXT NOT NULL CHECK (scope_kind IN ('session', 'conversation', 'task')),
		owner_id INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		retired_at INTEGER,
		record TEXT NOT NULL CHECK (json_valid(record))
	) STRICT`,
			`CREATE INDEX documents_by_address
		ON documents (kind, scope_kind, owner_id, family, key_value, created_at DESC, retired_at)`,
			"CREATE INDEX documents_by_scope ON documents (scope_kind, owner_id, id)",
			"CREATE INDEX documents_by_scope_kind ON documents (scope_kind, owner_id, kind, id)",
			`CREATE TABLE document_revisions (
		document_id INTEGER NOT NULL,
		seq INTEGER NOT NULL,
		kind TEXT NOT NULL CHECK (kind IN ('base', 'delta')),
		version INTEGER NOT NULL,
		content TEXT NOT NULL CHECK (json_valid(content)),
		PRIMARY KEY (document_id, seq)
	) STRICT`,
			"CREATE INDEX document_revisions_by_kind ON document_revisions (document_id, kind, seq DESC)",
		],
	},
];

const context = BACKGROUND_CONTEXT;
const directories = new Set<string>();
const owner = { conversationId: idFromNumber<ConversationId>(1), taskId: idFromNumber<TaskId>(2) };
const conversations: readonly ConversationRecord[] = [
	{ id: owner.conversationId },
	{ id: idFromNumber<ConversationId>(3), owner },
];
const submissions: readonly SubmissionRecord[] = [
	{
		id: idFromNumber<SubmissionId>(4),
		conversationId: owner.conversationId,
		requestId: "queued",
		type: "input",
		status: "queued",
	},
	{
		id: idFromNumber<SubmissionId>(5),
		conversationId: owner.conversationId,
		requestId: "placed",
		type: "input",
		status: "placed",
		entry: idFromNumber<EntryId>(8),
	},
	{
		id: idFromNumber<SubmissionId>(6),
		conversationId: owner.conversationId,
		requestId: "done",
		type: "write",
		status: "done",
		entry: idFromNumber<EntryId>(8),
	},
	{
		id: idFromNumber<SubmissionId>(7),
		conversationId: owner.conversationId,
		requestId: "unanswered",
		type: "input",
		status: "unanswered",
		reason: "retained",
	},
];

async function databasePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-security-storage-upgrade-"));
	directories.add(directory);
	return join(directory, "storage.sqlite");
}

async function createReleasedDatabase(path: string): Promise<void> {
	const database = await openNodeSqliteDatabase(path);
	try {
		await applySqliteMigrations(database, RELEASED_MIGRATIONS);
		database.transaction(() => {
			for (const record of conversations) {
				database.prepare("INSERT INTO record_ids (id, record_type) VALUES (?, 'conversation')").run(record.id);
				database
					.prepare("INSERT INTO conversations (id, record) VALUES (?, ?)")
					.run(record.id, JSON.stringify(record));
			}
			for (const record of submissions) {
				database.prepare("INSERT INTO record_ids (id, record_type) VALUES (?, 'submission')").run(record.id);
				database
					.prepare("INSERT INTO submissions (id, conversation_id, request_id, record) VALUES (?, ?, ?, ?)")
					.run(record.id, record.conversationId, JSON.stringify(record.requestId), JSON.stringify(record));
			}
			database.prepare("UPDATE durable_metadata SET next_id = '20', next_seq = 7 WHERE singleton = 1").run();
		});
	} finally {
		database.close();
	}
}

function schema(database: SqliteDatabase): object[] {
	return database
		.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
		.all();
}

afterEach(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

describe("released SQLite storage upgrade (smarty-dev#2241 A8)", () => {
	it("preserves the actual released version 1 statements exactly", () => {
		expect(SQLITE_MIGRATIONS[0]).toEqual(RELEASED_MIGRATIONS[0]);
		expect(CURRENT_SQLITE_SCHEMA_VERSION).toBe(2);
	});

	it("reopens a released database and continues every changed write through public storage", async () => {
		const path = await databasePath();
		await createReleasedDatabase(path);
		const storage = await openNodeSqliteStorage(path);
		try {
			expect(
				(await storage.scanConversations({ ownerConversationId: owner.conversationId }, 10, undefined, context))
					.items,
			).toEqual([conversations[1]]);
			expect((await storage.scanConversations({ ownerTaskId: owner.taskId }, 10, undefined, context)).items).toEqual(
				[conversations[1]],
			);
			for (const record of conversations) expect(await storage.conversation(record.id, context)).toEqual(record);
			for (const record of submissions) {
				expect(await storage.submission(record.id, context)).toEqual(record);
				expect(await storage.submissionByRequest(record.conversationId, record.requestId!, context)).toEqual(
					record,
				);
				expect((await storage.scanSubmissions({ status: record.status }, 10, undefined, context)).items).toEqual([
					record,
				]);
			}
			const child: ConversationRecord = { id: await storage.mintId<ConversationId>(), owner };
			const ownerless: ConversationRecord = { id: await storage.mintId<ConversationId>() };
			const fresh: SubmissionRecord = {
				id: await storage.mintId<SubmissionId>(),
				conversationId: child.id,
				requestId: "fresh",
				type: "input",
				status: "queued",
			};
			expect(child.id).toBe(20);
			expect(
				await storage.commit(
					[
						{ type: "conversation", value: child },
						{ type: "conversation", value: ownerless },
						{ type: "submission", value: fresh },
					],
					context,
				),
			).toBe(7);
			expect(await storage.conversation(ownerless.id, context)).toEqual(ownerless);
			expect((await storage.scanConversations({ ownerTaskId: owner.taskId }, 10, undefined, context)).items).toEqual(
				[conversations[1], child],
			);
			expect(await storage.submissionByRequest(child.id, "fresh", context)).toEqual(fresh);
			const placed: SubmissionRecord = { ...fresh, status: "placed", entry: idFromNumber<EntryId>(8) };
			const done: SubmissionRecord = { ...placed, status: "done", answer: idFromNumber<EntryId>(9) };
			for (const updated of [
				placed,
				done,
				{
					id: submissions[0]!.id,
					conversationId: owner.conversationId,
					type: "input",
					status: "unanswered",
					reason: "updated",
				} satisfies SubmissionRecord,
			]) {
				await storage.commit([{ type: "submission", value: updated }], context);
				expect(await storage.submission(updated.id, context)).toEqual(updated);
				expect(
					(
						await storage.scanSubmissions(
							{ conversationId: updated.conversationId, status: updated.status },
							10,
							undefined,
							context,
						)
					).items,
				).toContainEqual(updated);
			}
		} finally {
			await storage.close(context);
		}
		const reopened = await openNodeSqliteStorage(path);
		try {
			expect((await reopened.submissionByRequest(idFromNumber<ConversationId>(20), "fresh", context))?.status).toBe(
				"done",
			);
			expect(await reopened.mintId<ConversationId>()).toBe(23);
		} finally {
			await reopened.close(context);
		}
	});

	it("rolls version 2 schema, backfill, indexes and version back on transaction failure", async () => {
		const path = await databasePath();
		await createReleasedDatabase(path);
		const database = await openNodeSqliteDatabase(path);
		try {
			const before = schema(database);
			const upgrade = SQLITE_MIGRATIONS[1]!;
			await expect(
				applySqliteMigrations(database, [
					RELEASED_MIGRATIONS[0]!,
					{
						version: 2,
						statements: [...upgrade.statements, "THIS IS NOT SQL"],
					},
				]),
			).rejects.toThrow();
			expect(schema(database)).toEqual(before);
			expect(database.prepare("SELECT version FROM durable_schema").get()).toEqual({ version: 1 });
			expect(database.prepare("SELECT record FROM conversations WHERE id = 3").get()).toEqual({
				record: JSON.stringify(conversations[1]),
			});
			expect(database.prepare("SELECT record FROM submissions WHERE id = 5").get()).toEqual({
				record: JSON.stringify(submissions[1]),
			});
			expect(database.prepare("SELECT next_id, next_seq FROM durable_metadata").get()).toEqual({
				next_id: "20",
				next_seq: 7,
			});
			await applySqliteMigrations(database);
			expect(database.prepare("SELECT version FROM durable_schema").get()).toEqual({ version: 2 });
			expect(
				database.prepare("SELECT owner_conversation_id, owner_task_id FROM conversations WHERE id = 3").get(),
			).toEqual({ owner_conversation_id: 1, owner_task_id: 2 });
			expect(database.prepare("SELECT status FROM submissions ORDER BY id").all()).toEqual(
				submissions.map((record) => ({ status: record.status })),
			);
		} finally {
			database.close();
		}
	});

	it("creates the same current schema fresh or via the released migration, retaining constraints and indexes", async () => {
		const upgradedPath = await databasePath();
		await createReleasedDatabase(upgradedPath);
		const upgraded = await openNodeSqliteDatabase(upgradedPath);
		const fresh = await openNodeSqliteDatabase(await databasePath());
		try {
			await applySqliteMigrations(upgraded);
			await applySqliteMigrations(fresh);
			expect(schema(fresh)).toEqual(schema(upgraded));
			await applySqliteMigrations(upgraded);
			expect(upgraded.prepare("SELECT next_id, next_seq FROM durable_metadata").get()).toEqual({
				next_id: "20",
				next_seq: 7,
			});
			for (const database of [fresh, upgraded]) {
				expect(database.prepare("SELECT version FROM durable_schema").get()).toEqual({ version: 2 });
				expect(() =>
					database
						.prepare(
							"INSERT INTO submissions (id, conversation_id, status, record) VALUES (99, 1, 'invalid', '{}')",
						)
						.run(),
				).toThrow();
				const ownerPlan = database
					.prepare(
						"EXPLAIN QUERY PLAN SELECT record FROM conversations WHERE owner_task_id = ? AND id > ? ORDER BY id",
					)
					.all<{ detail: string }>(2, 0);
				const statusPlan = database
					.prepare("EXPLAIN QUERY PLAN SELECT record FROM submissions WHERE status = ? AND id > ? ORDER BY id")
					.all<{ detail: string }>("queued", 0);
				expect(ownerPlan.map((row) => row.detail).join("\n")).toContain("conversations_by_owner_task");
				expect(statusPlan.map((row) => row.detail).join("\n")).toContain("submissions_by_status");
			}
		} finally {
			upgraded.close();
			fresh.close();
		}
	});
});
