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
	type SqliteMigration,
} from "../src/storage/sqlite/index.ts";
import { openNodeSqliteDatabase, openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import {
	type ConversationId,
	type ConversationRecord,
	type EntryId,
	ROOT_CONVERSATION_ID,
	type SubmissionId,
	type SubmissionRecord,
	type TaskId,
} from "../src/types.ts";

// PR #107, A8: copied verbatim from INITIAL_SCHEMA at the released PR merge base
// 3bf97b045b0336e7976826c0e825c9d641299fb5 via git show (not the migration under test).
const RELEASED_SCHEMA_V1: readonly string[] = [
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
];

async function createReleasedDatabase(path: string) {
	const conversation: ConversationRecord = {
		id: idFromNumber<ConversationId>(2),
		owner: { conversationId: ROOT_CONVERSATION_ID, taskId: idFromNumber<TaskId>(3) },
	};
	const entry = {
		id: idFromNumber<EntryId>(4),
		conversationId: conversation.id,
		kind: "retained",
		data: { retained: true },
	};
	const submissions: readonly SubmissionRecord[] = [
		{
			id: idFromNumber<SubmissionId>(5),
			conversationId: conversation.id,
			requestId: "base-request",
			type: "input",
			status: "queued",
		},
		{
			id: idFromNumber<SubmissionId>(6),
			conversationId: conversation.id,
			type: "input",
			status: "placed",
			entry: entry.id,
		},
		{
			id: idFromNumber<SubmissionId>(7),
			conversationId: conversation.id,
			type: "input",
			status: "done",
			entry: entry.id,
			answer: entry.id,
		},
		{
			id: idFromNumber<SubmissionId>(8),
			conversationId: conversation.id,
			type: "input",
			status: "unanswered",
			reason: "retained",
		},
	];
	const task = {
		id: idFromNumber<TaskId>(3),
		conversationId: ROOT_CONVERSATION_ID,
		kind: "retained.task",
		version: 1,
		input: null,
		state: { status: "pending", checkpoint: null },
		after: [],
		background: false,
		abortRequested: false,
	};
	const database = await openNodeSqliteDatabase(path);
	try {
		await applySqliteMigrations(database, [{ version: 1, statements: RELEASED_SCHEMA_V1 }]);
		database.transaction(() => {
			for (const record of [{ id: ROOT_CONVERSATION_ID }, conversation]) {
				database
					.prepare("INSERT INTO conversations (id, record) VALUES (?, ?)")
					.run(record.id, JSON.stringify(record));
				database.prepare("INSERT INTO record_ids (id, record_type) VALUES (?, 'conversation')").run(record.id);
			}
			database
				.prepare(
					"INSERT INTO tasks (id, conversation_id, kind, status, abort_requested, background, record) VALUES (?, ?, ?, 'pending', 0, 0, ?)",
				)
				.run(task.id, task.conversationId, JSON.stringify(task.kind), JSON.stringify(task));
			database.prepare("INSERT INTO record_ids (id, record_type) VALUES (?, 'task')").run(task.id);
			database
				.prepare("INSERT INTO entries (id, conversation_id, commit_seq, record) VALUES (?, ?, 1, ?)")
				.run(entry.id, entry.conversationId, JSON.stringify(entry));
			database.prepare("INSERT INTO record_ids (id, record_type) VALUES (?, 'entry')").run(entry.id);
			for (const submission of submissions) {
				database
					.prepare("INSERT INTO submissions (id, conversation_id, request_id, record) VALUES (?, ?, ?, ?)")
					.run(
						submission.id,
						submission.conversationId,
						submission.requestId === undefined ? null : JSON.stringify(submission.requestId),
						JSON.stringify(submission),
					);
				database.prepare("INSERT INTO record_ids (id, record_type) VALUES (?, 'submission')").run(submission.id);
			}
			database.exec("UPDATE durable_metadata SET next_id = '9', next_seq = 2 WHERE singleton = 1");
		});
		expect(database.prepare("SELECT version FROM durable_schema WHERE singleton = 1").get()).toEqual({ version: 1 });
	} finally {
		database.close();
	}
	return { conversation, entry, task, submissions };
}

const directories = new Set<string>();

async function databasePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-migrations-"));
	directories.add(directory);
	return join(directory, "storage.sqlite");
}

afterEach(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

describe("durable SQLite migrations", () => {
	it("keeps the released version-1 SQL immutable", () => {
		expect(SQLITE_MIGRATIONS[0]).toEqual({ version: 1, statements: RELEASED_SCHEMA_V1 });
	});

	// PR #107, A8: continue real reads and writes after reopening an actual released-v1 database.
	it("upgrades the released schema to v2 and continues reading and writing retained rows", async () => {
		const path = await databasePath();
		const { conversation, entry, task, submissions } = await createReleasedDatabase(path);
		const storage = await openNodeSqliteStorage(path);
		try {
			expect(await storage.conversation(conversation.id, BACKGROUND_CONTEXT)).toEqual(conversation);
			expect(
				(
					await storage.scanConversations(
						{ ownerConversationId: ROOT_CONVERSATION_ID },
						10,
						undefined,
						BACKGROUND_CONTEXT,
					)
				).items,
			).toEqual([conversation]);
			expect(
				(
					await storage.scanConversations(
						{ ownerTaskId: conversation.owner!.taskId },
						10,
						undefined,
						BACKGROUND_CONTEXT,
					)
				).items,
			).toEqual([conversation]);
			expect(await storage.entry(entry.id, BACKGROUND_CONTEXT)).toEqual({ entry, commitSeq: 1 });
			expect(await storage.task(task.id, BACKGROUND_CONTEXT)).toEqual(task);
			expect(await storage.submissionByRequest(conversation.id, "base-request", BACKGROUND_CONTEXT)).toEqual(
				submissions[0],
			);
			for (const submission of submissions) {
				expect(await storage.submission(submission.id, BACKGROUND_CONTEXT)).toEqual(submission);
				expect(
					(
						await storage.scanSubmissions(
							{ conversationId: conversation.id, status: submission.status },
							10,
							undefined,
							BACKGROUND_CONTEXT,
						)
					).items,
				).toEqual([submission]);
			}
			const newConversation = { ...conversation, id: await storage.mintId<ConversationId>() };
			const newEntry = { ...entry, id: await storage.mintId<EntryId>(), conversationId: newConversation.id };
			const newSubmission: SubmissionRecord = {
				id: await storage.mintId<SubmissionId>(),
				conversationId: newConversation.id,
				requestId: "after-upgrade",
				type: "input",
				status: "queued",
			};
			expect(newConversation.id).toBe(9);
			expect(
				await storage.commit(
					[
						{ type: "conversation", value: newConversation },
						{ type: "entry", value: newEntry },
						{ type: "submission", value: newSubmission },
						{
							type: "submission",
							value: {
								id: submissions[0]!.id,
								conversationId: conversation.id,
								type: "input",
								status: "unanswered",
								reason: "after-upgrade",
							},
						},
					],
					BACKGROUND_CONTEXT,
				),
			).toBe(2);
			expect(await storage.conversation(newConversation.id, BACKGROUND_CONTEXT)).toEqual(newConversation);
			expect(await storage.entry(newEntry.id, BACKGROUND_CONTEXT)).toEqual({ entry: newEntry, commitSeq: 2 });
			expect(await storage.submissionByRequest(newConversation.id, "after-upgrade", BACKGROUND_CONTEXT)).toEqual(
				newSubmission,
			);
			expect((await storage.scanSubmissions({ status: "queued" }, 10, undefined, BACKGROUND_CONTEXT)).items).toEqual(
				[newSubmission],
			);
		} finally {
			await storage.close(BACKGROUND_CONTEXT);
		}
		const database = await openNodeSqliteDatabase(path);
		try {
			expect(database.prepare("SELECT version FROM durable_schema WHERE singleton = 1").get()).toEqual({
				version: 2,
			});
			expect(database.prepare("SELECT next_id, next_seq FROM durable_metadata WHERE singleton = 1").get()).toEqual({
				next_id: "12",
				next_seq: 3,
			});
			expect(
				database.prepare("SELECT owner_conversation_id, owner_task_id FROM conversations WHERE id = 1").get(),
			).toEqual({ owner_conversation_id: null, owner_task_id: null });
			expect(
				database
					.prepare(
						"SELECT count(*) AS count FROM sqlite_schema WHERE type = 'index' AND name IN ('conversations_by_owner_conversation', 'conversations_by_owner_task', 'submissions_by_request', 'submissions_by_conversation', 'submissions_by_status')",
					)
					.get(),
			).toEqual({ count: 5 });
			expect(database.prepare("SELECT count(*) AS count FROM conversations").get()).toEqual({ count: 3 });
			expect(database.prepare("SELECT count(*) AS count FROM submissions").get()).toEqual({ count: 5 });
			expect(() => database.prepare("UPDATE submissions SET status = 'invalid'").run()).toThrow();
			expect(() => database.prepare("UPDATE submissions SET status = NULL").run()).toThrow();
		} finally {
			database.close();
		}
		const reopened = await openNodeSqliteStorage(path);
		try {
			expect(await reopened.entry(entry.id, BACKGROUND_CONTEXT)).toEqual({ entry, commitSeq: 1 });
			expect(await reopened.mintId<EntryId>()).toBe(12);
		} finally {
			await reopened.close(BACKGROUND_CONTEXT);
		}
	});

	// PR #107, A8: a failure after all v2 statements must leave the released database intact.
	it("rolls the v1-to-v2 upgrade back atomically and can retry it", async () => {
		const path = await databasePath();
		const { conversation, submissions } = await createReleasedDatabase(path);
		const database = await openNodeSqliteDatabase(path);
		try {
			const upgrade = SQLITE_MIGRATIONS[1]!;
			await expect(
				applySqliteMigrations(database, [
					SQLITE_MIGRATIONS[0]!,
					{ version: 2, statements: [...upgrade.statements, "THIS IS NOT SQL"] },
				]),
			).rejects.toThrow();
			expect(database.prepare("SELECT version FROM durable_schema WHERE singleton = 1").get()).toEqual({
				version: 1,
			});
			expect(
				database
					.prepare("PRAGMA table_info(conversations)")
					.all<{ name: string }>()
					.map((row) => row.name),
			).toEqual(["id", "record"]);
			expect(
				database
					.prepare("PRAGMA table_info(submissions)")
					.all<{ name: string }>()
					.map((row) => row.name),
			).toEqual(["id", "conversation_id", "request_id", "record"]);
			expect(database.prepare("SELECT record FROM conversations WHERE id = ?").get(conversation.id)).toEqual({
				record: JSON.stringify(conversation),
			});
			expect(database.prepare("SELECT record FROM submissions ORDER BY id").all()).toEqual(
				submissions.map((submission) => ({ record: JSON.stringify(submission) })),
			);
			expect(
				database
					.prepare(
						"SELECT count(*) AS count FROM sqlite_schema WHERE name IN ('submissions_v2', 'conversations_by_owner_conversation', 'conversations_by_owner_task', 'submissions_by_conversation', 'submissions_by_status')",
					)
					.get(),
			).toEqual({ count: 0 });
			await applySqliteMigrations(database);
			expect(database.prepare("SELECT version FROM durable_schema WHERE singleton = 1").get()).toEqual({
				version: 2,
			});
			expect(database.prepare("SELECT status FROM submissions ORDER BY id").all()).toEqual(
				submissions.map((submission) => ({ status: submission.status })),
			);
		} finally {
			database.close();
		}
	});

	it("creates the current schema and can be applied repeatedly", async () => {
		const database = await openNodeSqliteDatabase(await databasePath());
		try {
			await applySqliteMigrations(database);
			await applySqliteMigrations(database);
			expect(database.prepare("SELECT version FROM durable_schema WHERE singleton = 1").get()).toEqual({
				version: CURRENT_SQLITE_SCHEMA_VERSION,
			});
			expect(database.prepare("SELECT next_id, next_seq FROM durable_metadata WHERE singleton = 1").get()).toEqual({
				next_id: "2",
				next_seq: 1,
			});
		} finally {
			database.close();
		}
	});

	it("rejects a database newer than the portable core", async () => {
		const path = await databasePath();
		const database = await openNodeSqliteDatabase(path);
		await applySqliteMigrations(database);
		database
			.prepare("UPDATE durable_schema SET version = ? WHERE singleton = 1")
			.run(CURRENT_SQLITE_SCHEMA_VERSION + 1);
		database.close();

		await expect(openNodeSqliteStorage(path)).rejects.toThrow("is newer than supported version");
	});

	it("rolls initial bootstrap and every pending migration back together", async () => {
		const database = await openNodeSqliteDatabase(await databasePath());
		try {
			const failed: readonly SqliteMigration[] = [
				{
					version: 1,
					statements: [
						"CREATE TABLE migration_first (value TEXT) STRICT",
						"INSERT INTO migration_first (value) VALUES ('retained')",
					],
				},
				{
					version: 2,
					statements: ["CREATE TABLE migration_second (value TEXT) STRICT", "THIS IS NOT SQL"],
				},
			];
			await expect(applySqliteMigrations(database, failed)).rejects.toThrow();
			expect(
				database
					.prepare(
						"SELECT count(*) AS count FROM sqlite_schema WHERE name IN ('durable_schema', 'migration_first', 'migration_second')",
					)
					.get(),
			).toEqual({ count: 0 });

			await applySqliteMigrations(database, [
				failed[0],
				{ version: 2, statements: ["CREATE TABLE migration_second (value TEXT) STRICT"] },
			]);
			expect(database.prepare("SELECT version FROM durable_schema WHERE singleton = 1").get()).toEqual({
				version: 2,
			});
			expect(database.prepare("SELECT value FROM migration_first").get()).toEqual({ value: "retained" });
		} finally {
			database.close();
		}
	});

	it("rolls a failed migration back and preserves stored data for a successful retry", async () => {
		const path = await databasePath();
		const storage = await openNodeSqliteStorage(path);
		await storage.commit(
			[
				{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
				{
					type: "entry",
					value: {
						id: idFromNumber<EntryId>(2),
						conversationId: ROOT_CONVERSATION_ID,
						kind: "retained",
						data: { retained: true },
					},
				},
			],
			BACKGROUND_CONTEXT,
		);
		await storage.close(BACKGROUND_CONTEXT);

		const database = await openNodeSqliteDatabase(path);
		const nextVersion = CURRENT_SQLITE_SCHEMA_VERSION + 1;
		const failedMigrations: readonly SqliteMigration[] = [
			...SQLITE_MIGRATIONS,
			{
				version: nextVersion,
				statements: ["CREATE TABLE migration_probe (value TEXT) STRICT", "THIS IS NOT SQL"],
			},
		];
		await expect(applySqliteMigrations(database, failedMigrations)).rejects.toThrow();
		expect(database.prepare("SELECT version FROM durable_schema WHERE singleton = 1").get()).toEqual({
			version: CURRENT_SQLITE_SCHEMA_VERSION,
		});
		expect(
			database
				.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'migration_probe'")
				.get(),
		).toEqual({ count: 0 });

		const successfulMigrations: readonly SqliteMigration[] = [
			...SQLITE_MIGRATIONS,
			{ version: nextVersion, statements: ["CREATE TABLE migration_probe (value TEXT) STRICT"] },
		];
		await applySqliteMigrations(database, successfulMigrations);
		expect(database.prepare("SELECT version FROM durable_schema WHERE singleton = 1").get()).toEqual({
			version: nextVersion,
		});
		expect(database.prepare("SELECT record, commit_seq FROM entries WHERE id = 2").get()).toEqual({
			record: JSON.stringify({
				id: 2,
				conversationId: ROOT_CONVERSATION_ID,
				kind: "retained",
				data: { retained: true },
			}),
			commit_seq: 1,
		});
		expect(database.prepare("SELECT next_id, next_seq FROM durable_metadata WHERE singleton = 1").get()).toEqual({
			next_id: "3",
			next_seq: 2,
		});
		database.close();
	});
});
