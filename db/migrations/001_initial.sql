CREATE TABLE users (
  id text PRIMARY KEY,
  display_name varchar(80) NOT NULL CHECK (btrim(display_name) <> ''),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_display_name_unique
  ON users (lower(display_name));

CREATE TABLE user_roles (
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('SUBMITTER', 'REVIEWER', 'ADMIN')),
  PRIMARY KEY (user_id, role)
);

CREATE TABLE contents (
  id text PRIMARY KEY,
  author_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title varchar(200) NOT NULL CHECK (btrim(title) <> ''),
  body text NOT NULL CHECK (btrim(body) <> '' AND length(body) <= 50000),
  risk text NOT NULL CHECK (risk IN ('LOW', 'HIGH')),
  status text NOT NULL CHECK (
    status IN ('DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED')
  ),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (updated_at >= created_at)
);

CREATE TABLE content_revisions (
  id text PRIMARY KEY,
  content_id text NOT NULL REFERENCES contents(id) ON DELETE RESTRICT,
  revision_no integer NOT NULL CHECK (revision_no > 0),
  title varchar(200) NOT NULL CHECK (btrim(title) <> ''),
  body text NOT NULL CHECK (btrim(body) <> '' AND length(body) <= 50000),
  risk text NOT NULL CHECK (risk IN ('LOW', 'HIGH')),
  author_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  author_name_snapshot varchar(80) NOT NULL CHECK (
    btrim(author_name_snapshot) <> ''
  ),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (content_id, revision_no),
  UNIQUE (id, content_id)
);

CREATE TABLE review_rounds (
  id text PRIMARY KEY,
  content_id text NOT NULL REFERENCES contents(id) ON DELETE RESTRICT,
  revision_id text NOT NULL UNIQUE,
  round_no integer NOT NULL CHECK (round_no > 0),
  required_approvals smallint NOT NULL CHECK (required_approvals IN (1, 2)),
  status text NOT NULL CHECK (status IN ('OPEN', 'APPROVED', 'REJECTED')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (content_id, round_no),
  FOREIGN KEY (revision_id, content_id)
    REFERENCES content_revisions(id, content_id) ON DELETE RESTRICT,
  CHECK (
    (status = 'OPEN' AND completed_at IS NULL)
    OR (status IN ('APPROVED', 'REJECTED') AND completed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX review_rounds_one_open_per_content
  ON review_rounds (content_id)
  WHERE status = 'OPEN';

CREATE TABLE review_decisions (
  id text PRIMARY KEY,
  round_id text NOT NULL REFERENCES review_rounds(id) ON DELETE RESTRICT,
  reviewer_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewer_name_snapshot varchar(80) NOT NULL CHECK (
    btrim(reviewer_name_snapshot) <> ''
  ),
  decision text NOT NULL CHECK (decision IN ('APPROVE', 'REJECT')),
  comment varchar(2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (round_id, reviewer_id),
  CHECK (
    decision <> 'REJECT'
    OR (comment IS NOT NULL AND btrim(comment) <> '')
  )
);

CREATE TABLE idempotency_requests (
  actor_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  operation varchar(160) NOT NULL,
  idempotency_key varchar(100) NOT NULL,
  request_hash char(64) NOT NULL,
  status_code integer NOT NULL CHECK (status_code BETWEEN 200 AND 299),
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, operation, idempotency_key)
);

CREATE TABLE capacity_counters (
  resource text PRIMARY KEY CHECK (resource IN ('users', 'contents', 'idempotency')),
  used bigint NOT NULL CHECK (used >= 0)
);

INSERT INTO capacity_counters (resource, used) VALUES
  ('users', 0),
  ('contents', 0),
  ('idempotency', 0);

CREATE INDEX contents_by_author_updated
  ON contents (author_id, updated_at DESC);
CREATE INDEX contents_by_status_updated
  ON contents (status, updated_at DESC);
CREATE INDEX review_rounds_history
  ON review_rounds (content_id, round_no DESC);
CREATE INDEX review_rounds_open_queue
  ON review_rounds (started_at, content_id) WHERE status = 'OPEN';
CREATE INDEX review_decisions_by_round
  ON review_decisions (round_id, created_at, id);
CREATE INDEX idempotency_requests_cleanup
  ON idempotency_requests (created_at);

INSERT INTO users (id, display_name) VALUES
  ('user-alice', 'Alice'),
  ('user-bob', 'Bob'),
  ('user-chen', 'Chen'),
  ('user-diana', 'Diana');

INSERT INTO user_roles (user_id, role) VALUES
  ('user-alice', 'SUBMITTER'),
  ('user-alice', 'REVIEWER'),
  ('user-bob', 'REVIEWER'),
  ('user-chen', 'REVIEWER'),
  ('user-diana', 'ADMIN');

UPDATE capacity_counters SET used = 4 WHERE resource = 'users';