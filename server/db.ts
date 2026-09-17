import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const USER_IDS = {
  alice: 'user-alice',
  bob: 'user-bob',
  chen: 'user-chen',
  diana: 'user-diana',
} as const

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('SUBMITTER', 'REVIEWER', 'ADMIN')),
  PRIMARY KEY (user_id, role)
);

CREATE UNIQUE INDEX IF NOT EXISTS users_display_name_unique
  ON users(display_name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS contents (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  body TEXT NOT NULL CHECK (length(trim(body)) > 0),
  risk TEXT NOT NULL CHECK (risk IN ('LOW', 'HIGH')),
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS content_revisions (
  id TEXT PRIMARY KEY,
  content_id TEXT NOT NULL REFERENCES contents(id) ON DELETE RESTRICT,
  revision_no INTEGER NOT NULL CHECK (revision_no > 0),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  risk TEXT NOT NULL CHECK (risk IN ('LOW', 'HIGH')),
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  author_name_snapshot TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  UNIQUE (content_id, revision_no),
  UNIQUE (id, content_id)
);

CREATE TABLE IF NOT EXISTS review_rounds (
  id TEXT PRIMARY KEY,
  content_id TEXT NOT NULL REFERENCES contents(id) ON DELETE RESTRICT,
  revision_id TEXT NOT NULL UNIQUE,
  round_no INTEGER NOT NULL CHECK (round_no > 0),
  required_approvals INTEGER NOT NULL CHECK (required_approvals IN (1, 2)),
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'APPROVED', 'REJECTED')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (content_id, round_no),
  FOREIGN KEY (revision_id, content_id)
    REFERENCES content_revisions(id, content_id) ON DELETE RESTRICT,
  CHECK (
    (status = 'OPEN' AND completed_at IS NULL)
    OR (status IN ('APPROVED', 'REJECTED') AND completed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS review_rounds_one_open_per_content
  ON review_rounds(content_id) WHERE status = 'OPEN';

CREATE TABLE IF NOT EXISTS review_decisions (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES review_rounds(id) ON DELETE RESTRICT,
  reviewer_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewer_name_snapshot TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('APPROVE', 'REJECT')),
  comment TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (round_id, reviewer_id),
  CHECK (
    decision <> 'REJECT'
    OR (comment IS NOT NULL AND length(trim(comment)) > 0)
  )
);

CREATE TABLE IF NOT EXISTS idempotency_requests (
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, operation, idempotency_key)
);

CREATE INDEX IF NOT EXISTS contents_by_author_updated
  ON contents(author_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS review_rounds_history
  ON review_rounds(content_id, round_no DESC);
CREATE INDEX IF NOT EXISTS review_rounds_open_queue
  ON review_rounds(started_at, content_id) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS review_decisions_by_round
  ON review_decisions(round_id, created_at);
`

export function defaultDatabasePath(): string {
  return join(process.env.DATA_DIR ?? '.data', 'reviewflow.db')
}

export function createDatabase(filename = defaultDatabasePath()): DatabaseSync {
  if (filename !== ':memory:') {
    mkdirSync(dirname(filename), { recursive: true })
  }

  const database = new DatabaseSync(filename)
  database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  if (filename !== ':memory:') {
    database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
  }
  database.exec(schema)
  seedUsers(database)
  return database
}

export function withImmediateTransaction<T>(
  database: DatabaseSync,
  action: () => T,
): T {
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = action()
    database.exec('COMMIT')
    return result
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // The original error is more useful when BEGIN itself was interrupted.
    }
    throw error
  }
}

function seedUsers(database: DatabaseSync): void {
  const now = new Date().toISOString()
  const insertUser = database.prepare(`
    INSERT OR IGNORE INTO users (id, display_name, created_at)
    VALUES (?, ?, ?)
  `)
  const insertRole = database.prepare(`
    INSERT OR IGNORE INTO user_roles (user_id, role)
    VALUES (?, ?)
  `)

  withImmediateTransaction(database, () => {
    insertUser.run(USER_IDS.alice, 'Alice', now)
    insertUser.run(USER_IDS.bob, 'Bob', now)
    insertUser.run(USER_IDS.chen, 'Chen', now)
    insertUser.run(USER_IDS.diana, 'Diana', now)

    insertRole.run(USER_IDS.alice, 'SUBMITTER')
    insertRole.run(USER_IDS.alice, 'REVIEWER')
    insertRole.run(USER_IDS.bob, 'REVIEWER')
    insertRole.run(USER_IDS.chen, 'REVIEWER')
    insertRole.run(USER_IDS.diana, 'ADMIN')
  })
}