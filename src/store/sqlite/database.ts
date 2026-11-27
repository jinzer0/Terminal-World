import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { addDays } from '../../core/clock.js';
import { generateId } from '../../core/crypto.js';
import { applyMigrations } from './migrations.js';

export type TombstoneKind =
  | 'delete_content'
  | 'withdraw_member'
  | 'purge_member_pii'
  | 'privacy_delete';

export interface TombstoneInput {
  recordedAt: string;
  kind: TombstoneKind;
  targetKind: string;
  targetId: string;
  payload?: Record<string, unknown>;
}

export interface TombstoneRecord {
  seq: number;
  recordedAt: string;
  kind: TombstoneKind;
  targetKind: string;
  targetId: string;
  payload: Record<string, unknown>;
}

export interface OperationalLogInput {
  occurredAt: string;
  eventType: string;
  outcome: 'success' | 'failure' | 'denied';
  errorCode?: string | null;
  memberId?: string | null;
  loginIdSnapshot?: string | null;
  nicknameSnapshot?: string | null;
  ipAddress?: string | null;
}

export interface WorldDatabaseOptions {
  /** File path to SQLite DB or ':memory:' for in-memory tests. */
  dbPath?: string;
  /** Data directory containing world.db, tombstones.log, backups/. */
  dataDir?: string;
  /** Optional explicit path for external append-only tombstones.log. */
  tombstoneLogPath?: string;
}

export class WorldDatabase {
  readonly db: DatabaseSync;
  readonly dbPath: string;
  readonly dataDir: string | null;
  readonly tombstoneLogPath: string | null;
  private txDepth = 0;
  private closed = false;

  constructor(options: WorldDatabaseOptions = {}) {
    if (options.dbPath === ':memory:') {
      this.dbPath = ':memory:';
      this.dataDir = options.dataDir ?? null;
      this.tombstoneLogPath = options.tombstoneLogPath ?? null;
    } else if (options.dbPath) {
      this.dbPath = options.dbPath;
      this.dataDir = options.dataDir ?? dirname(options.dbPath);
      this.tombstoneLogPath = options.tombstoneLogPath ?? join(this.dataDir, 'tombstones.log');
    } else {
      const dir = options.dataDir ?? join(process.cwd(), '.terminal-world-data');
      this.dataDir = dir;
      this.dbPath = join(dir, 'world.db');
      this.tombstoneLogPath = options.tombstoneLogPath ?? join(dir, 'tombstones.log');
    }

    if (this.dbPath !== ':memory:') {
      mkdirSync(dirname(this.dbPath), { recursive: true, mode: 0o700 });
    }

    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    if (this.dbPath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
    }

    applyMigrations(this.db);
  }

  /**
   * Executes `fn` inside a serialized write transaction (`BEGIN IMMEDIATE`).
   * Nested calls use SQLite SAVEPOINTs so composed service operations remain atomic.
   */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      const sp = `sp_${this.txDepth}`;
      this.txDepth += 1;
      this.db.exec(`SAVEPOINT ${sp}`);
      try {
        const result = fn();
        this.db.exec(`RELEASE SAVEPOINT ${sp}`);
        return result;
      } catch (error) {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
        this.db.exec(`RELEASE SAVEPOINT ${sp}`);
        throw error;
      } finally {
        this.txDepth -= 1;
      }
    }

    this.txDepth = 1;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.txDepth = 0;
    }
  }

  appendTombstone(input: TombstoneInput): TombstoneRecord {
    const payload = input.payload ?? {};
    const payloadJson = JSON.stringify(payload);
    const result = this.db.prepare(`
      INSERT INTO tombstones (recorded_at, kind, target_kind, target_id, payload_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(input.recordedAt, input.kind, input.targetKind, input.targetId, payloadJson);

    const record: TombstoneRecord = {
      seq: Number(result.lastInsertRowid),
      recordedAt: input.recordedAt,
      kind: input.kind,
      targetKind: input.targetKind,
      targetId: input.targetId,
      payload,
    };

    if (this.tombstoneLogPath) {
      mkdirSync(dirname(this.tombstoneLogPath), { recursive: true, mode: 0o700 });
      appendFileSync(this.tombstoneLogPath, `${JSON.stringify(record)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
    }

    return record;
  }

  readTombstoneLog(): TombstoneRecord[] {
    if (this.tombstoneLogPath && existsSync(this.tombstoneLogPath)) {
      const content = readFileSync(this.tombstoneLogPath, 'utf8');
      const records: TombstoneRecord[] = [];
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        records.push(JSON.parse(trimmed) as TombstoneRecord);
      }
      return records;
    }

    const rows = this.db.prepare(`
      SELECT seq, recorded_at, kind, target_kind, target_id, payload_json
      FROM tombstones
      ORDER BY seq ASC
    `).all() as Array<{
      seq: number;
      recorded_at: string;
      kind: TombstoneKind;
      target_kind: string;
      target_id: string;
      payload_json: string;
    }>;

    return rows.map(row => ({
      seq: row.seq,
      recordedAt: row.recorded_at,
      kind: row.kind,
      targetKind: row.target_kind,
      targetId: row.target_id,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    }));
  }

  recordOperationalLog(input: OperationalLogInput): void {
    const expiresAt = addDays(input.occurredAt, 14);
    this.db.prepare(`
      INSERT INTO operational_logs (
        id, occurred_at, event_type, outcome, error_code,
        member_id, login_id_snapshot, nickname_snapshot, ip_address, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      generateId(),
      input.occurredAt,
      input.eventType,
      input.outcome,
      input.errorCode ?? null,
      input.memberId ?? null,
      input.loginIdSnapshot ?? null,
      input.nicknameSnapshot ?? null,
      input.ipAddress ?? null,
      expiresAt,
    );
  }

  /**
   * Creates a consistent point-in-time SQLite backup using `VACUUM INTO`.
   */
  backupTo(destPath: string): void {
    mkdirSync(dirname(destPath), { recursive: true, mode: 0o700 });
    if (existsSync(destPath)) {
      unlinkSync(destPath);
    }
    const escaped = destPath.replaceAll("'", "''");
    this.db.exec(`VACUUM INTO '${escaped}'`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
