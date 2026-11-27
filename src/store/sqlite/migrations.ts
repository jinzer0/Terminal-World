import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const INITIAL_BOARDS: ReadonlyArray<{
  id: string;
  name: string;
  description: string;
  sortOrder: number;
}> = [
  { id: 'free', name: '자유', description: '자유로운 개발·일상 이야기를 나누는 게시판', sortOrder: 1 },
  { id: 'dev-qna', name: '개발 질문', description: '기술 질문과 트러블슈팅을 나누는 게시판', sortOrder: 2 },
  { id: 'info', name: '정보 공유', description: '유용한 개발 아티클·도구·소식을 공유하는 게시판', sortOrder: 3 },
  { id: 'mcp', name: 'MCP', description: 'Model Context Protocol 도구와 워크플로를 공유하는 게시판', sortOrder: 4 },
  { id: 'skills', name: 'Skills', description: '에이전트 스킬과 자동화 노하우를 공유하는 게시판', sortOrder: 5 },
  { id: 'opensource', name: 'opensource', description: '오픈소스 프로젝트 소개와 기여 경험을 나누는 게시판', sortOrder: 6 },
  { id: 'recruitment', name: '프로젝트/공모전 모집', description: '프로젝트·공모전·해커톤 팀원을 모집하는 게시판', sortOrder: 7 },
];

export const MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: 1,
    name: '001_initial_world_schema',
    sql: `
-- (1) 계정 · 인증 · 세션 · 연동 자격
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  login_id TEXT NOT NULL,
  login_id_key TEXT NOT NULL UNIQUE,
  nickname TEXT NOT NULL,
  nickname_key TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('member', 'admin')),
  role_version INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL CHECK (state IN ('active', 'withdrawn')),
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  login_locked_until TEXT,
  failed_recovery_count INTEGER NOT NULL DEFAULT 0,
  recovery_locked_until TEXT,
  created_at TEXT NOT NULL,
  withdrawn_at TEXT,
  pii_purge_at TEXT
);

CREATE TABLE IF NOT EXISTS name_reservations (
  kind TEXT NOT NULL CHECK (kind IN ('login_id', 'nickname')),
  lookup_key TEXT NOT NULL,
  reserved_until TEXT NOT NULL,
  PRIMARY KEY (kind, lookup_key)
);

CREATE TABLE IF NOT EXISTS recovery_credentials (
  member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  member_id TEXT REFERENCES members(id) ON DELETE CASCADE,
  is_guest INTEGER NOT NULL DEFAULT 0 CHECK (is_guest IN (0, 1)),
  channel TEXT NOT NULL CHECK (channel IN ('ssh', 'cli', 'mcp')),
  current_space_id TEXT NOT NULL DEFAULT 'space:lobby',
  world_x INTEGER NOT NULL DEFAULT 10,
  world_y INTEGER NOT NULL DEFAULT 6,
  last_heartbeat_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_active
  ON user_sessions(member_id) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS integration_grants (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('cli', 'mcp')),
  label TEXT NOT NULL,
  scopes TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_reason TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_integration_grants_member
  ON integration_grants(member_id);

CREATE TABLE IF NOT EXISTS auth_approval_codes (
  code TEXT PRIMARY KEY,
  requested_channel TEXT NOT NULL CHECK (requested_channel IN ('cli', 'mcp')),
  requested_scopes TEXT NOT NULL,
  requested_ttl_sec INTEGER NOT NULL,
  client_label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'exchanged', 'expired')),
  approved_grant_id TEXT REFERENCES integration_grants(id) ON DELETE SET NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS access_tokens (
  token_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES integration_grants(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_access_tokens_grant
  ON access_tokens(grant_id);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES integration_grants(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL,
  replaced_by_hash TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_grant
  ON refresh_tokens(grant_id);

-- (2) 프로필 · 개인 공간 · 방명록
CREATE TABLE IF NOT EXISTS profiles (
  member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  introduction TEXT NOT NULL DEFAULT '',
  technology_stack_json TEXT NOT NULL DEFAULT '[]',
  current_status TEXT NOT NULL DEFAULT '',
  project_url TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS personal_spaces (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL UNIQUE REFERENCES members(id) ON DELETE CASCADE,
  ascii_art TEXT NOT NULL DEFAULT '',
  color_theme TEXT NOT NULL DEFAULT 'dark' CHECK (color_theme IN ('dark', 'light', 'green', 'amber')),
  grid_slot INTEGER NOT NULL UNIQUE,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS guestbook_entries (
  id TEXT PRIMARY KEY,
  target_space_id TEXT REFERENCES personal_spaces(id) ON DELETE SET NULL,
  author_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_guestbook_target
  ON guestbook_entries(target_space_id, created_at);

-- (3) 게시판 · 모집 · 댓글 · 공지 · 채팅
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  sort_order INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id),
  author_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_posts_board_created
  ON posts(board_id, created_at DESC);

CREATE TABLE IF NOT EXISTS recruitment_details (
  post_id TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  recruitment_type TEXT NOT NULL CHECK (recruitment_type IN ('project', 'contest', 'hackathon')),
  recruitment_state TEXT NOT NULL CHECK (recruitment_state IN ('open', 'closed')),
  progress_note TEXT NOT NULL,
  roles_json TEXT NOT NULL,
  required_skills_json TEXT NOT NULL,
  no_skill_required INTEGER NOT NULL DEFAULT 0 CHECK (no_skill_required IN (0, 1)),
  participation_period TEXT NOT NULL,
  weekly_time TEXT NOT NULL,
  participation_mode TEXT NOT NULL CHECK (participation_mode IN ('online', 'offline', 'hybrid')),
  region TEXT NOT NULL DEFAULT '',
  contact_method TEXT NOT NULL,
  deadline_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recruitment_bookmarks (
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  saved_at TEXT NOT NULL,
  PRIMARY KEY (member_id, post_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_comments_post_created
  ON comments(post_id, created_at ASC);

CREATE TABLE IF NOT EXISTS notices (
  id TEXT PRIMARY KEY,
  author_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  publication_state TEXT NOT NULL CHECK (publication_state IN ('published', 'ended')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL DEFAULT 'space:rooftop',
  author_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_chat_room_sent
  ON chat_messages(room_id, sent_at DESC);

-- (4) 집중 시간
CREATE TABLE IF NOT EXISTS focus_sessions (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  started_session_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  counted_seconds INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_focus_active_per_member
  ON focus_sessions(member_id) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS focus_daily_totals (
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  kst_date TEXT NOT NULL,
  total_seconds INTEGER NOT NULL,
  PRIMARY KEY (member_id, kst_date)
);

CREATE INDEX IF NOT EXISTS idx_focus_daily_date_seconds
  ON focus_daily_totals(kst_date, total_seconds DESC);

-- (5) 신고 · 삭제 이력 · 운영 로그 · 개인정보 요청 · 멱등성 · Tombstone
CREATE TABLE IF NOT EXISTS content_reports (
  id TEXT PRIMARY KEY,
  reporter_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('post', 'comment', 'guestbook', 'chat')),
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  review_state TEXT NOT NULL CHECK (review_state IN ('received', 'reviewed')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('deleted', 'no_action')),
  resolution_reason TEXT,
  reviewer_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS report_dedup_keys (
  reporter_member_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('post', 'comment', 'guestbook', 'chat')),
  target_id TEXT NOT NULL,
  PRIMARY KEY (reporter_member_id, target_kind, target_id)
);

CREATE TABLE IF NOT EXISTS report_rate_limits (
  member_id TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  last_accepted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS moderation_deletions (
  id TEXT PRIMARY KEY,
  admin_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('post', 'comment', 'guestbook', 'chat')),
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operational_logs (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  event_type TEXT NOT NULL,
  outcome TEXT NOT NULL,
  error_code TEXT,
  member_id TEXT,
  login_id_snapshot TEXT,
  nickname_snapshot TEXT,
  ip_address TEXT,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS privacy_deletion_requests (
  id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  verification_note TEXT NOT NULL,
  status TEXT NOT NULL,
  outcome TEXT,
  reason TEXT,
  received_at TEXT NOT NULL,
  completed_at TEXT,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope_key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed')),
  response_json TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tombstones (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('delete_content', 'withdraw_member', 'purge_member_pii', 'privacy_delete')),
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

-- (6) 오픈소스 공개 저장소 · 이슈 · 트렌드 관측 · 데모 AI 설명
CREATE TABLE IF NOT EXISTS opensource_repos (
  full_name TEXT PRIMARY KEY,
  source_url TEXT NOT NULL,
  language TEXT,
  topics_json TEXT NOT NULL DEFAULT '[]',
  license_spdx TEXT,
  stars_count INTEGER,
  repo_created_at TEXT,
  size_tier TEXT NOT NULL CHECK (size_tier IN ('small', 'medium', 'large', 'unknown')),
  is_newborn INTEGER CHECK (is_newborn IS NULL OR is_newborn IN (0, 1)),
  checked_at TEXT NOT NULL,
  etag TEXT,
  data_origin TEXT NOT NULL CHECK (data_origin IN ('live_github', 'seed_snapshot')),
  stale INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1))
);

CREATE TABLE IF NOT EXISTS repo_star_observations (
  full_name TEXT NOT NULL REFERENCES opensource_repos(full_name) ON DELETE CASCADE,
  observed_at TEXT NOT NULL,
  stars_count INTEGER NOT NULL,
  PRIMARY KEY (full_name, observed_at)
);

CREATE TABLE IF NOT EXISTS external_issues (
  id TEXT PRIMARY KEY,
  repo_full_name TEXT NOT NULL REFERENCES opensource_repos(full_name) ON DELETE CASCADE,
  issue_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body_excerpt TEXT NOT NULL DEFAULT '',
  labels_json TEXT NOT NULL DEFAULT '[]',
  source_url TEXT NOT NULL,
  source_state TEXT NOT NULL CHECK (source_state IN ('open', 'closed', 'deleted_or_inaccessible')),
  assignees_json TEXT NOT NULL DEFAULT '[]',
  linked_prs_json TEXT NOT NULL DEFAULT '[]',
  recent_activity_at TEXT,
  checked_at TEXT NOT NULL,
  data_origin TEXT NOT NULL CHECK (data_origin IN ('live_github', 'seed_snapshot'))
);

CREATE TABLE IF NOT EXISTS issue_explanations (
  issue_id TEXT NOT NULL REFERENCES external_issues(id) ON DELETE CASCADE,
  source_checked_at TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode = 'demo'),
  availability_state TEXT NOT NULL CHECK (availability_state IN ('available', 'unavailable')),
  summary TEXT,
  background_knowledge TEXT,
  recommendation_reason TEXT,
  evidence_links_json TEXT NOT NULL DEFAULT '[]',
  demo_authored_at TEXT,
  PRIMARY KEY (issue_id, source_checked_at)
);
`,
  },
];

export function applyMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>;
  const applied = new Set(appliedRows.map(row => row.version));

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const upsertBoard = db.prepare(`
    INSERT INTO boards (id, name, description, sort_order)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      sort_order = excluded.sort_order
  `);
  for (const board of INITIAL_BOARDS) {
    upsertBoard.run(board.id, board.name, board.description, board.sortOrder);
  }
}
