import type { SqliteDatabase } from "./database.ts";

export type SqliteMigration = {
	readonly version: number;
	readonly statements: readonly string[];
};

// next_id is TEXT because node:sqlite rejects INTEGER results outside JavaScript's safe integer range.
const INITIAL_SCHEMA: readonly string[] = [
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

// Materialize the query columns from the existing JSON records before adding their indexes.
// Rebuild submissions so status has the same NOT NULL/CHECK constraints for fresh and upgraded databases.
const QUERY_COLUMNS: readonly string[] = [
	// v1.0 adds waiting/completing; old task rows need the new constraint too.
	`CREATE TABLE tasks_v2 (
		id INTEGER PRIMARY KEY,
		conversation_id INTEGER NOT NULL,
		kind TEXT NOT NULL,
		status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'completing', 'terminal')),
		abort_requested INTEGER NOT NULL CHECK (abort_requested IN (0, 1)),
		background INTEGER NOT NULL CHECK (background IN (0, 1)),
		record TEXT NOT NULL CHECK (json_valid(record))
	) STRICT`,
	`INSERT INTO tasks_v2 (id, conversation_id, kind, status, abort_requested, background, record)
		SELECT id, conversation_id, kind, status, abort_requested, background, record FROM tasks`,
	"DROP TABLE tasks",
	"ALTER TABLE tasks_v2 RENAME TO tasks",
	"CREATE INDEX tasks_by_status ON tasks (status, id)",
	"CREATE INDEX tasks_by_conversation ON tasks (conversation_id, id)",
	"CREATE INDEX tasks_by_kind ON tasks (kind, id)",
	"CREATE INDEX tasks_by_abort_requested ON tasks (abort_requested, id)",
	"CREATE INDEX tasks_by_background ON tasks (background, id)",
	"ALTER TABLE conversations ADD COLUMN owner_conversation_id INTEGER",
	"ALTER TABLE conversations ADD COLUMN owner_task_id INTEGER",
	`UPDATE conversations SET
		owner_conversation_id = json_extract(record, '$.owner.conversationId'),
		owner_task_id = json_extract(record, '$.owner.taskId')`,
	"CREATE INDEX conversations_by_owner_conversation ON conversations (owner_conversation_id, id)",
	"CREATE INDEX conversations_by_owner_task ON conversations (owner_task_id, id)",
	`CREATE TABLE submissions_v2 (
		id INTEGER PRIMARY KEY,
		conversation_id INTEGER NOT NULL,
		request_id TEXT,
		status TEXT NOT NULL CHECK (status IN ('queued', 'placed', 'done', 'unanswered')),
		record TEXT NOT NULL CHECK (json_valid(record))
	) STRICT`,
	`INSERT INTO submissions_v2 (id, conversation_id, request_id, status, record)
		SELECT id, conversation_id, request_id, json_extract(record, '$.status'), record FROM submissions`,
	"DROP TABLE submissions",
	"ALTER TABLE submissions_v2 RENAME TO submissions",
	"CREATE INDEX submissions_by_request ON submissions (conversation_id, request_id)",
	"CREATE INDEX submissions_by_conversation ON submissions (conversation_id, id)",
	"CREATE INDEX submissions_by_status ON submissions (status, id)",
];

/** Immutable, ordered schema history. Append new migrations; never edit released ones. */
export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [
	{ version: 1, statements: INITIAL_SCHEMA },
	{ version: 2, statements: QUERY_COLUMNS },
];

export const CURRENT_SQLITE_SCHEMA_VERSION = SQLITE_MIGRATIONS.at(-1)?.version ?? 0;

type SchemaRow = { readonly version: number };

/** Apply all pending schema migrations atomically. */
export async function applySqliteMigrations(
	database: SqliteDatabase,
	migrations: readonly SqliteMigration[] = SQLITE_MIGRATIONS,
): Promise<void> {
	for (let index = 0; index < migrations.length; index++) {
		if (migrations[index]?.version !== index + 1) {
			throw new Error("Durable SQLite migrations must have contiguous versions starting at 1");
		}
	}

	await database.transaction(async (transaction) => {
		await transaction.exec(`CREATE TABLE IF NOT EXISTS durable_schema (
			singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
			version INTEGER NOT NULL CHECK (version >= 0)
		) STRICT`);
		await transaction.run("INSERT OR IGNORE INTO durable_schema (singleton, version) VALUES (1, 0)");
		const row = await transaction.get<SchemaRow>("SELECT version FROM durable_schema WHERE singleton = 1");
		if (row === undefined) throw new Error("Durable SQLite schema metadata is missing");
		const currentVersion = migrations.at(-1)?.version ?? 0;
		if (row.version > currentVersion) {
			throw new Error(
				`Durable SQLite schema version ${row.version} is newer than supported version ${currentVersion}`,
			);
		}
		for (const migration of migrations) {
			if (migration.version <= row.version) continue;
			for (const statement of migration.statements) await transaction.exec(statement);
			await transaction.run("UPDATE durable_schema SET version = ? WHERE singleton = 1", migration.version);
		}
	});
}
