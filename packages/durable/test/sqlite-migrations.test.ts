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
	type EntryId,
	ROOT_CONVERSATION_ID,
	type SubmissionId,
	type TaskId,
	type TaskRecord,
} from "../src/types.ts";
import { BASE_SQLITE_SCHEMA } from "./fixtures/sqlite-schema-v1.ts";

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
	// pi#137 A1: populated released databases must receive the new lifecycle schema.
	it("reopens a populated version-1 database, backfills indexes and completes the new lifecycle", async () => {
		const path = await databasePath();
		const database = await openNodeSqliteDatabase(path);
		await applySqliteMigrations(database, [{ version: 1, statements: BASE_SQLITE_SCHEMA }]);
		const childId = idFromNumber<ConversationId>(2);
		const taskId = idFromNumber<TaskId<null>>(3);
		const entryId = idFromNumber<EntryId>(4);
		const submissionId = idFromNumber<SubmissionId>(5);
		const child = { id: childId, owner: { conversationId: ROOT_CONVERSATION_ID, taskId } };
		const task = {
			id: taskId,
			conversationId: childId,
			kind: "retained",
			version: 1,
			input: null,
			background: false,
			abortRequested: false,
			state: { status: "pending", checkpoint: null },
		} satisfies TaskRecord<null, null, null>;
		const entry = { id: entryId, conversationId: childId, kind: "retained", data: { private: true } };
		const submission = {
			id: submissionId,
			conversationId: childId,
			type: "input" as const,
			status: "queued" as const,
		};
		try {
			for (const [id, type] of [
				[1, "conversation"],
				[2, "conversation"],
				[3, "task"],
				[4, "entry"],
				[5, "submission"],
			] as const)
				await database.run("INSERT INTO record_ids VALUES (?, ?)", id, type);
			await database.run("INSERT INTO conversations VALUES (?, ?)", 1, JSON.stringify({ id: 1 }));
			await database.run("INSERT INTO conversations VALUES (?, ?)", 2, JSON.stringify(child));
			await database.run(
				"INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?)",
				3,
				2,
				JSON.stringify("retained"),
				"pending",
				0,
				0,
				JSON.stringify(task),
			);
			await database.run("INSERT INTO entries VALUES (?, ?, ?, ?, ?)", 4, 2, null, 1, JSON.stringify(entry));
			await database.run("INSERT INTO submissions VALUES (?, ?, ?, ?)", 5, 2, null, JSON.stringify(submission));
			await database.run("UPDATE durable_metadata SET next_id = '6', next_seq = 2");
		} finally {
			await database.close();
		}

		const storage = await openNodeSqliteStorage(path);
		try {
			expect(
				await storage.scanConversations(
					{ ownerConversationId: ROOT_CONVERSATION_ID },
					10,
					undefined,
					BACKGROUND_CONTEXT,
				),
			).toEqual({ items: [child] });
			expect(await storage.scanConversations({ ownerTaskId: taskId }, 10, undefined, BACKGROUND_CONTEXT)).toEqual({
				items: [child],
			});
			expect(
				await storage.scanSubmissions(
					{ conversationId: childId, status: "queued" },
					10,
					undefined,
					BACKGROUND_CONTEXT,
				),
			).toEqual({ items: [submission] });
			expect(await storage.entry(entryId, BACKGROUND_CONTEXT)).toEqual({ entry, commitSeq: 1 });
			expect(await storage.task(taskId, BACKGROUND_CONTEXT)).toEqual(task);
			for (const value of [
				{ ...task, state: { status: "waiting", checkpoint: null, on: [], policy: "allSettled" } },
				{ ...task, state: { status: "completing", outcome: { status: "completed", result: null } } },
				{ ...task, state: { status: "terminal", outcome: { status: "completed", result: null } } },
			] as const) {
				await storage.commit([{ type: "task", value }], BACKGROUND_CONTEXT);
				expect((await storage.task(taskId, BACKGROUND_CONTEXT))?.state).toEqual(value.state);
			}
			await storage.commit(
				[{ type: "submission", value: { ...submission, status: "done", entry: entryId, answer: entryId } }],
				BACKGROUND_CONTEXT,
			);
			await storage.commit(
				[{ type: "conversation", value: { id: await storage.mintId<ConversationId>() } }],
				BACKGROUND_CONTEXT,
			);
		} finally {
			await storage.close(BACKGROUND_CONTEXT);
		}
		const reopened = await openNodeSqliteDatabase(path);
		try {
			expect(await reopened.get("SELECT version FROM durable_schema")).toEqual({ version: 2 });
			expect(await reopened.get("SELECT count(*) AS count FROM record_ids")).toEqual({ count: 6 });
			expect(await reopened.get("SELECT status FROM tasks WHERE id = 3")).toEqual({ status: "terminal" });
			expect(await reopened.get("SELECT status FROM submissions WHERE id = 5")).toEqual({ status: "done" });
		} finally {
			await reopened.close();
		}
	});

	// pi#137 A1: released migration statements are immutable, including their old CHECKs.
	it("preserves the released version-1 schema", () => {
		const normalize = (sql: string) => sql.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();
		expect(SQLITE_MIGRATIONS[0].statements.map(normalize)).toEqual(BASE_SQLITE_SCHEMA.map(normalize));
	});

	it("atomically rolls the lifecycle backfill back on failure and allows retry", async () => {
		const database = await openNodeSqliteDatabase(await databasePath());
		try {
			await applySqliteMigrations(database, [{ version: 1, statements: BASE_SQLITE_SCHEMA }]);
			const record = JSON.stringify({ id: 2, conversationId: 1, type: "input", status: "queued" });
			await database.run("INSERT INTO submissions VALUES (2, 1, NULL, ?)", record);
			await expect(
				applySqliteMigrations(database, [
					SQLITE_MIGRATIONS[0],
					{ version: 2, statements: [...SQLITE_MIGRATIONS[1].statements, "THIS IS NOT SQL"] },
				]),
			).rejects.toThrow();
			expect(await database.get("SELECT version FROM durable_schema")).toEqual({ version: 1 });
			expect(await database.get("SELECT record FROM submissions WHERE id = 2")).toEqual({ record });
			expect(
				(await database.all<{ name: string }>("PRAGMA table_info(conversations)")).map((row) => row.name),
			).toEqual(["id", "record"]);
			expect(
				(await database.all<{ name: string }>("PRAGMA table_info(submissions)")).map((row) => row.name),
			).toEqual(["id", "conversation_id", "request_id", "record"]);
			await applySqliteMigrations(database);
			expect(await database.get("SELECT status, record FROM submissions WHERE id = 2")).toEqual({
				status: "queued",
				record,
			});
		} finally {
			await database.close();
		}
	});

	it("creates the current schema and can be applied repeatedly", async () => {
		const database = await openNodeSqliteDatabase(await databasePath());
		try {
			await applySqliteMigrations(database);
			await applySqliteMigrations(database);
			expect(await database.get("SELECT version FROM durable_schema WHERE singleton = 1")).toEqual({
				version: CURRENT_SQLITE_SCHEMA_VERSION,
			});
			expect(await database.get("SELECT next_id, next_seq FROM durable_metadata WHERE singleton = 1")).toEqual({
				next_id: "2",
				next_seq: 1,
			});
		} finally {
			await database.close();
		}
	});

	it("rejects a database newer than the portable core", async () => {
		const path = await databasePath();
		const database = await openNodeSqliteDatabase(path);
		await applySqliteMigrations(database);
		await database.run(
			"UPDATE durable_schema SET version = ? WHERE singleton = 1",
			CURRENT_SQLITE_SCHEMA_VERSION + 1,
		);
		await database.close();

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
				await database.get(
					"SELECT count(*) AS count FROM sqlite_schema WHERE name IN ('durable_schema', 'migration_first', 'migration_second')",
				),
			).toEqual({ count: 0 });

			await applySqliteMigrations(database, [
				failed[0],
				{ version: 2, statements: ["CREATE TABLE migration_second (value TEXT) STRICT"] },
			]);
			expect(await database.get("SELECT version FROM durable_schema WHERE singleton = 1")).toEqual({
				version: 2,
			});
			expect(await database.get("SELECT value FROM migration_first")).toEqual({
				value: "retained",
			});
		} finally {
			await database.close();
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
		expect(await database.get("SELECT version FROM durable_schema WHERE singleton = 1")).toEqual({
			version: CURRENT_SQLITE_SCHEMA_VERSION,
		});
		expect(
			await database.get(
				"SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'migration_probe'",
			),
		).toEqual({ count: 0 });

		const successfulMigrations: readonly SqliteMigration[] = [
			...SQLITE_MIGRATIONS,
			{ version: nextVersion, statements: ["CREATE TABLE migration_probe (value TEXT) STRICT"] },
		];
		await applySqliteMigrations(database, successfulMigrations);
		expect(await database.get("SELECT version FROM durable_schema WHERE singleton = 1")).toEqual({
			version: nextVersion,
		});
		expect(await database.get("SELECT record, commit_seq FROM entries WHERE id = 2")).toEqual({
			record: JSON.stringify({
				id: 2,
				conversationId: ROOT_CONVERSATION_ID,
				kind: "retained",
				data: { retained: true },
			}),
			commit_seq: 1,
		});
		expect(await database.get("SELECT next_id, next_seq FROM durable_metadata WHERE singleton = 1")).toEqual({
			next_id: "3",
			next_seq: 2,
		});
		await database.close();
	});
});
