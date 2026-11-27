import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FakeClock,
  parseKstDeadline,
  splitByKstMidnight,
  toKstDateString,
} from '../src/core/clock.js';
import { AuthService } from '../src/core/auth-service.js';
import { ServiceError } from '../src/core/errors.js';
import { parseRecoveryCode } from '../src/service/validation.js';
import { WorldDatabase } from '../src/store/sqlite/database.js';

test('atomic signup creates member, profile, personal space grid_slot, and one-time recovery code', () => {
  const clock = new FakeClock('2026-11-28T01:00:00.000Z');
  const worldDb = new WorldDatabase({ dbPath: ':memory:' });
  try {
    const auth = new AuthService(worldDb, clock);
    const first = auth.signup({
      loginId: 'Alice_01',
      nickname: '앨리스',
      password: 'Password!23',
    });

    assert.equal(first.member.loginId, 'Alice_01');
    assert.equal(first.member.loginIdKey, 'alice_01');
    assert.equal(first.member.nickname, '앨리스');
    assert.equal(first.member.role, 'member');
    assert.equal(first.member.state, 'active');
    assert.equal(first.personalSpace.gridSlot, 0);
    assert.equal(first.personalSpace.colorTheme, 'dark');
    assert.equal(parseRecoveryCode(first.recoveryCode), first.recoveryCodeRaw);

    const second = auth.signup({
      loginId: 'Bob_02',
      nickname: 'BobDev',
      password: 'Password!23',
    });
    assert.equal(second.personalSpace.gridSlot, 1);

    // 7 boards are seeded automatically
    const boards = worldDb.db.prepare('SELECT id FROM boards ORDER BY sort_order ASC').all() as Array<{ id: string }>;
    assert.deepEqual(
      boards.map(b => b.id),
      ['free', 'dev-qna', 'info', 'mcp', 'skills', 'opensource', 'recruitment'],
    );
  } finally {
    worldDb.close();
  }
});

test('signup rejects duplicate loginId/nickname case-insensitively and respects 90-day name reservations', () => {
  const clock = new FakeClock('2026-11-28T01:00:00.000Z');
  const worldDb = new WorldDatabase({ dbPath: ':memory:' });
  try {
    const auth = new AuthService(worldDb, clock);
    auth.signup({
      loginId: 'Mina_Dev',
      nickname: 'Mina',
      password: 'Password!23',
    });

    assert.throws(
      () => auth.signup({ loginId: 'mina_dev', nickname: 'OtherName', password: 'Password!23' }),
      (err: unknown) => err instanceof ServiceError && err.code === 'CONFLICT' && err.field === 'loginId',
    );

    assert.throws(
      () => auth.signup({ loginId: 'other_id', nickname: 'MINA', password: 'Password!23' }),
      (err: unknown) => err instanceof ServiceError && err.code === 'CONFLICT' && err.field === 'nickname',
    );

    // 90-day name reservation blocks reuse until expiry
    worldDb.db.prepare(`
      INSERT INTO name_reservations (kind, lookup_key, reserved_until)
      VALUES ('login_id', 'reserved_id', '2027-02-26T01:00:00.000Z')
    `).run();

    assert.throws(
      () => auth.signup({ loginId: 'Reserved_ID', nickname: 'FreshOne', password: 'Password!23' }),
      (err: unknown) => err instanceof ServiceError && err.code === 'CONFLICT' && err.field === 'loginId',
    );

    // After reservation expires, signup succeeds
    clock.set('2027-02-26T01:00:01.000Z');
    const created = auth.signup({ loginId: 'Reserved_ID', nickname: 'FreshOne', password: 'Password!23' });
    assert.equal(created.member.loginId, 'Reserved_ID');
  } finally {
    worldDb.close();
  }
});

test('login is case-insensitive, locks for 5 minutes after 5 failures, and resets counter after unlock', () => {
  const clock = new FakeClock('2026-11-28T01:00:00.000Z');
  const worldDb = new WorldDatabase({ dbPath: ':memory:' });
  try {
    const auth = new AuthService(worldDb, clock);
    const { member } = auth.signup({
      loginId: 'CaseUser',
      nickname: '케이스유저',
      password: 'Password!23',
    });

    // Case-insensitive login succeeds
    const ok = auth.login({ loginId: 'caseuser', password: 'Password!23' });
    assert.equal(ok.member.id, member.id);

    // 4 failures -> AUTH_FAILED
    for (let i = 0; i < 4; i += 1) {
      assert.throws(
        () => auth.login({ loginId: 'CASEUSER', password: 'WrongPass!99' }),
        (err: unknown) => err instanceof ServiceError && err.code === 'AUTH_FAILED',
      );
    }

    // 5th failure -> AUTH_LOCKED for 5 minutes
    assert.throws(
      () => auth.login({ loginId: 'CASEUSER', password: 'WrongPass!99' }),
      (err: unknown) => err instanceof ServiceError && err.code === 'AUTH_LOCKED',
    );

    // Even with correct password while locked -> AUTH_LOCKED
    clock.advanceMinutes(4);
    assert.throws(
      () => auth.login({ loginId: 'caseuser', password: 'Password!23' }),
      (err: unknown) => err instanceof ServiceError && err.code === 'AUTH_LOCKED',
    );

    // After 5 minutes -> succeeds and resets failed_login_count
    clock.advanceMinutes(1);
    clock.advanceSeconds(1);
    const unlocked = auth.login({ loginId: 'caseuser', password: 'Password!23' });
    assert.equal(unlocked.member.failedLoginCount, 0);
    assert.equal(unlocked.member.loginLockedUntil, null);
  } finally {
    worldDb.close();
  }
});

test('setMemberRole increments role_version and persists across DB restart, backup, and tombstone log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-wave0-'));
  try {
    const clock = new FakeClock('2026-11-28T02:00:00.000Z');
    const db1 = new WorldDatabase({ dataDir: dir });
    const auth1 = new AuthService(db1, clock);
    const created = auth1.signup({
      loginId: 'admin_one',
      nickname: '관리자일',
      password: 'Password!23',
    });
    const promoted = auth1.setMemberRole(created.member.id, 'admin');
    assert.equal(promoted.role, 'admin');
    assert.equal(promoted.roleVersion, 2);

    const tombstone = db1.appendTombstone({
      recordedAt: clock.now().toISOString(),
      kind: 'delete_content',
      targetKind: 'post',
      targetId: 'post-1',
      payload: { reason: 'test' },
    });
    assert.equal(tombstone.seq, 1);

    const backupPath = join(dir, 'backups', 'world-20261128.db');
    db1.backupTo(backupPath);
    assert.equal(existsSync(backupPath), true);
    db1.close();

    // Reopen from disk and verify persistence + tombstone log
    const db2 = new WorldDatabase({ dataDir: dir });
    const auth2 = new AuthService(db2, clock);
    const loaded = auth2.getMemberById(created.member.id);
    assert.ok(loaded);
    assert.equal(loaded.role, 'admin');
    assert.equal(loaded.roleVersion, 2);
    assert.equal(db2.readTombstoneLog().length, 1);
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Asia/Seoul KST midnight splitting and deadline parsing work accurately', () => {
  // 2026-11-28T14:59:50Z = 2026-11-28 23:59:50 KST
  // 2026-11-28T15:00:25Z = 2026-11-29 00:00:25 KST
  const slices = splitByKstMidnight('2026-11-28T14:59:50.000Z', '2026-11-28T15:00:25.000Z');
  assert.deepEqual(slices, [
    { kstDate: '2026-11-28', seconds: 10 },
    { kstDate: '2026-11-29', seconds: 25 },
  ]);
  assert.equal(toKstDateString('2026-11-28T15:00:00.000Z'), '2026-11-29');

  // Date-only deadline -> end of KST day (14:59:59.999Z)
  assert.equal(parseKstDeadline('2026-12-01'), '2026-12-01T14:59:59.999Z');
  // KST local datetime without offset
  assert.equal(parseKstDeadline('2026-12-01T18:00'), '2026-12-01T09:00:00.000Z');
});
