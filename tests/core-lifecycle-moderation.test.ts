import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createElement } from 'react';
import { render } from 'ink';
import { AccountLifecycleService } from '../src/core/account-lifecycle-service.js';
import { AuthService } from '../src/core/auth-service.js';
import { BoardService } from '../src/core/board-service.js';
import { ChatService } from '../src/core/chat-service.js';
import { addDays, addHours, FakeClock } from '../src/core/clock.js';
import { generateId, hashSecret } from '../src/core/crypto.js';
import { ServiceError } from '../src/core/errors.js';
import { FocusService } from '../src/core/focus-service.js';
import { GuestbookService } from '../src/core/guestbook-service.js';
import { ModerationService } from '../src/core/moderation-service.js';
import { PresenceService } from '../src/core/presence-service.js';
import { RealtimeHub } from '../src/core/realtime-hub.js';
import { RecruitmentService } from '../src/core/recruitment-service.js';
import { RetentionService } from '../src/core/retention-service.js';
import { WorldDatabase } from '../src/store/sqlite/database.js';
import { AccountSecurityScreen } from '../src/tui/screens/AccountSecurityScreen.js';
import { AdminPanelScreen } from '../src/tui/screens/AdminPanelScreen.js';

function createTestEnv(initialIso = '2026-11-28T01:00:00.000Z', dbOptions: { dataDir?: string } = {}) {
  const clock = new FakeClock(initialIso);
  const worldDb = dbOptions.dataDir
    ? new WorldDatabase({ dataDir: dbOptions.dataDir })
    : new WorldDatabase({ dbPath: ':memory:' });
  const hub = new RealtimeHub(clock);
  const auth = new AuthService(worldDb, clock);
  const presence = new PresenceService(worldDb, clock, hub);
  const focus = new FocusService(worldDb, clock, hub);
  const lifecycle = new AccountLifecycleService(worldDb, clock, { hub });
  const moderation = new ModerationService(worldDb, clock, { hub });
  const retention = new RetentionService(worldDb, clock);
  const board = new BoardService(worldDb, clock);
  const recruitment = new RecruitmentService(worldDb, clock);
  const guestbook = new GuestbookService(worldDb, clock);
  const chat = new ChatService(worldDb, clock, hub);

  return {
    clock,
    worldDb,
    hub,
    auth,
    presence,
    focus,
    lifecycle,
    moderation,
    retention,
    board,
    recruitment,
    guestbook,
    chat,
  };
}

function seedIntegrationGrant(
  worldDb: WorldDatabase,
  memberId: string,
  nowIso: string,
): { grantId: string; accessHash: string; refreshHash: string } {
  const grantId = generateId();
  const accessHash = hashSecret(`access-${grantId}`);
  const refreshHash = hashSecret(`refresh-${grantId}`);

  worldDb.db.prepare(`
    INSERT INTO integration_grants (id, member_id, channel, label, scopes, expires_at, created_at)
    VALUES (?, ?, 'cli', 'Test CLI', '["read","write"]', ?, ?)
  `).run(grantId, memberId, addDays(nowIso, 7), nowIso);

  worldDb.db.prepare(`
    INSERT INTO access_tokens (token_hash, grant_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(accessHash, grantId, addHours(nowIso, 1), nowIso);

  worldDb.db.prepare(`
    INSERT INTO refresh_tokens (token_hash, grant_id, family_id, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(refreshHash, grantId, generateId(), addDays(nowIso, 7), nowIso);

  return { grantId, accessHash, refreshHash };
}

test('recoverAccount enforces separate 5-failure 30m lock, uniform RECOVERY_FAILED, single-use code, and revokes sessions/focus/grants', () => {
  const env = createTestEnv('2026-11-28T01:00:00.000Z');
  try {
    const signup = env.auth.signup({
      loginId: 'RecoverUser',
      nickname: '복구유저',
      password: 'Password!23',
    });
    const memberId = signup.member.id;

    // Open session + focus + integration grant
    const session = env.presence.openSession({ memberId, channel: 'ssh' });
    env.focus.startFocus(memberId, session.id);
    const { grantId } = seedIntegrationGrant(env.worldDb, memberId, env.clock.now().toISOString());

    // Missing account yields uniform RECOVERY_FAILED
    assert.throws(
      () => env.lifecycle.recoverAccount({
        loginId: 'no_such_user',
        recoveryCode: signup.recoveryCode,
        newPassword: 'NewPassword!23',
      }),
      (err: unknown) => err instanceof ServiceError && err.code === 'RECOVERY_FAILED',
    );

    // 4 failed recovery attempts commit counter before throwing and do NOT lock login
    for (let i = 1; i <= 4; i += 1) {
      assert.throws(
        () => env.lifecycle.recoverAccount({
          loginId: 'recoveruser',
          recoveryCode: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-2222-3333',
          newPassword: 'NewPassword!23',
        }),
        (err: unknown) => err instanceof ServiceError && err.code === 'RECOVERY_FAILED',
      );
      const row = env.auth.getMemberById(memberId)!;
      assert.equal(row.failedRecoveryCount, i);
      assert.equal(row.failedLoginCount, 0);
    }

    // Login still works because recovery failure counter is separate from login failure counter
    assert.equal(env.auth.login({ loginId: 'RecoverUser', password: 'Password!23' }).member.id, memberId);

    // 5th consecutive failure triggers 30-minute lock and commits lock state before throwing
    assert.throws(
      () => env.lifecycle.recoverAccount({
        loginId: 'RecoverUser',
        recoveryCode: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-2222-3333',
        newPassword: 'NewPassword!23',
      }),
      (err: unknown) => err instanceof ServiceError && err.code === 'AUTH_LOCKED',
    );
    const lockedRow = env.auth.getMemberById(memberId)!;
    assert.equal(lockedRow.failedRecoveryCount, 5);
    assert.ok(lockedRow.recoveryLockedUntil);

    // Even with the valid code, recovery is blocked during the 30-minute lock
    env.clock.advanceMinutes(29);
    assert.throws(
      () => env.lifecycle.recoverAccount({
        loginId: 'RecoverUser',
        recoveryCode: signup.recoveryCode,
        newPassword: 'NewPassword!23',
      }),
      (err: unknown) => err instanceof ServiceError && err.code === 'AUTH_LOCKED',
    );

    // After 30 minutes, recovery succeeds once, closes sessions/focus, revokes grants/tokens, and rotates recovery code
    env.clock.advanceMinutes(1);
    const recovered = env.lifecycle.recoverAccount({
      loginId: 'RecoverUser',
      recoveryCode: signup.recoveryCode,
      newPassword: 'NewPassword!99',
    });
    assert.equal(recovered.closedSessionCount, 1);
    assert.equal(recovered.revokedGrantCount, 1);
    assert.notEqual(recovered.recoveryCodeRaw, signup.recoveryCodeRaw);

    // Old recovery code cannot be reused
    assert.throws(
      () => env.lifecycle.recoverAccount({
        loginId: 'RecoverUser',
        recoveryCode: signup.recoveryCode,
        newPassword: 'AnotherPass!99',
      }),
      (err: unknown) => err instanceof ServiceError && err.code === 'RECOVERY_FAILED',
    );

    // Old password fails, new password works
    assert.throws(
      () => env.auth.login({ loginId: 'RecoverUser', password: 'Password!23' }),
      (err: unknown) => err instanceof ServiceError && err.code === 'AUTH_FAILED',
    );
    assert.equal(env.auth.login({ loginId: 'RecoverUser', password: 'NewPassword!99' }).member.id, memberId);

    // Sessions, focus, and integration grants/tokens are all closed/revoked
    assert.equal(env.presence.listMemberActiveSessions(memberId).length, 0);
    assert.equal(env.focus.getFocusStatus(memberId).activeSession, null);
    const grant = env.worldDb.db.prepare('SELECT revoked_at FROM integration_grants WHERE id = ?').get(grantId) as { revoked_at: string | null };
    assert.ok(grant.revoked_at);
    const activeAccess = env.worldDb.db.prepare('SELECT COUNT(*) AS cnt FROM access_tokens WHERE grant_id = ? AND revoked_at IS NULL').get(grantId) as { cnt: number };
    const activeRefresh = env.worldDb.db.prepare('SELECT COUNT(*) AS cnt FROM refresh_tokens WHERE grant_id = ? AND revoked_at IS NULL').get(grantId) as { cnt: number };
    assert.equal(activeAccess.cnt, 0);
    assert.equal(activeRefresh.cnt, 0);
  } finally {
    env.worldDb.close();
  }
});

test('changePassword preserves currentSessionId and recovery_credentials while closing other sessions and revoking all grants/tokens', () => {
  const env = createTestEnv('2026-11-28T02:00:00.000Z');
  try {
    const signup = env.auth.signup({
      loginId: 'ChgPassUser',
      nickname: '비번유저',
      password: 'OldPassword!23',
    });
    const memberId = signup.member.id;

    const currentSession = env.presence.openSession({ memberId, channel: 'ssh' });
    const otherSession = env.presence.openSession({ memberId, channel: 'cli' });

    // Start focus on currentSession -> should stay active
    env.focus.startFocus(memberId, currentSession.id);
    const { grantId } = seedIntegrationGrant(env.worldDb, memberId, env.clock.now().toISOString());

    env.clock.advanceMinutes(5);
    const changed = env.lifecycle.changePassword({
      memberId,
      currentPassword: 'OldPassword!23',
      newPassword: 'NextPassword!45',
      currentSessionId: currentSession.id,
    });

    assert.equal(changed.changed, true);
    assert.equal(changed.preservedSessionId, currentSession.id);
    assert.equal(changed.closedSessionCount, 1);
    assert.equal(changed.revokedGrantCount, 1);

    const remaining = env.presence.listMemberActiveSessions(memberId);
    assert.deepEqual(remaining.map(s => s.id), [currentSession.id]);
    assert.ok(env.presence.getSessionById(otherSession.id)?.endedAt);
    assert.ok(env.focus.getFocusStatus(memberId).activeSession);

    // If focus was started on a closed session, changing password stops focus
    env.focus.stopFocus(memberId);
    const thirdSession = env.presence.openSession({ memberId, channel: 'ssh' });
    env.focus.startFocus(memberId, thirdSession.id);
    env.clock.advanceSeconds(45);
    env.lifecycle.changePassword({
      memberId,
      currentPassword: 'NextPassword!45',
      newPassword: 'ThirdPassword!67',
      currentSessionId: currentSession.id,
    });
    assert.equal(env.focus.getFocusStatus(memberId).activeSession, null);
    assert.equal(env.focus.getFocusStatus(memberId).todayCompletedSeconds, 345);

    // Grant & tokens were revoked
    const grant = env.worldDb.db.prepare('SELECT revoked_at FROM integration_grants WHERE id = ?').get(grantId) as { revoked_at: string | null };
    assert.ok(grant.revoked_at);

    // Recovery code was preserved and still works
    const recResult = env.lifecycle.recoverAccount({
      loginId: 'ChgPassUser',
      recoveryCode: signup.recoveryCode,
      newPassword: 'FourthPassword!89',
    });
    assert.equal(recResult.member.id, memberId);
  } finally {
    env.worldDb.close();
  }
});

test('reissueRecoveryCode verifies password, replaces recovery_credentials, and invalidates old code', () => {
  const env = createTestEnv('2026-11-28T03:00:00.000Z');
  try {
    const signup = env.auth.signup({
      loginId: 'ReissueUser',
      nickname: '재발급유저',
      password: 'Password!23',
    });

    assert.throws(
      () => env.lifecycle.reissueRecoveryCode({
        memberId: signup.member.id,
        currentPassword: 'WrongPassword!23',
      }),
      (err: unknown) => err instanceof ServiceError && err.code === 'AUTH_FAILED',
    );

    const reissued = env.lifecycle.reissueRecoveryCode({
      memberId: signup.member.id,
      currentPassword: 'Password!23',
    });
    assert.notEqual(reissued.recoveryCodeRaw, signup.recoveryCodeRaw);

    // Old code fails
    assert.throws(
      () => env.lifecycle.recoverAccount({
        loginId: 'ReissueUser',
        recoveryCode: signup.recoveryCode,
        newPassword: 'NewPassword!23',
      }),
      (err: unknown) => err instanceof ServiceError && err.code === 'RECOVERY_FAILED',
    );

    // New code succeeds
    const recovered = env.lifecycle.recoverAccount({
      loginId: 'ReissueUser',
      recoveryCode: reissued.recoveryCode,
      newPassword: 'NewPassword!23',
    });
    assert.equal(recovered.member.id, signup.member.id);
  } finally {
    env.worldDb.close();
  }
});

test('withdrawAccount requires confirm+password, reserves names 90d, deletes personal data, anonymizes content, and appends tombstone', () => {
  const env = createTestEnv('2026-11-28T01:00:00.000Z');
  try {
    const alice = env.auth.signup({ loginId: 'Alice_01', nickname: '앨리스', password: 'Password!23' });
    const bob = env.auth.signup({ loginId: 'Bob_02', nickname: '밥개발', password: 'Password!23' });

    const session = env.presence.openSession({ memberId: alice.member.id, channel: 'ssh' });
    env.focus.startFocus(alice.member.id, session.id);
    const { grantId } = seedIntegrationGrant(env.worldDb, alice.member.id, env.clock.now().toISOString());

    const post = env.board.createPost(alice.member.id, { boardId: 'free', title: '탈퇴 전 글', body: '본문' });
    const comment = env.board.createComment(alice.member.id, { postId: post.id, body: '탈퇴 전 댓글' });
    const recruit = env.recruitment.createRecruitment(bob.member.id, {
      title: '모집글',
      body: '함께해요',
      recruitmentType: 'project',
      progressNote: '진행 중',
      roles: ['백엔드'],
      requiredSkills: ['TypeScript'],
      participationPeriod: '4주',
      weeklyTime: '주 5시간',
      participationMode: 'online',
      contactMethod: 'DM',
      deadlineAt: '2026-12-20',
      ackPublic: true,
    });
    env.recruitment.setBookmark(alice.member.id, recruit.id, true);
    const gbOnAlice = env.guestbook.createEntry(bob.member.id, alice.personalSpace.id, '앨리스 공간 방명록');
    const gbByAlice = env.guestbook.createEntry(alice.member.id, bob.personalSpace.id, '밥 공간 방명록');
    const chatMsg = env.chat.sendMessage({ memberId: alice.member.id, body: '루프탑 안녕' });

    // Confirm must be true
    assert.throws(
      () => env.lifecycle.withdrawAccount({
        memberId: alice.member.id,
        password: 'Password!23',
        confirm: false,
      }),
      (err: unknown) => err instanceof ServiceError && err.code === 'INVALID_INPUT',
    );

    const withdrawn = env.lifecycle.withdrawAccount({
      memberId: alice.member.id,
      password: 'Password!23',
      confirm: true,
    });
    assert.equal(withdrawn.withdrawn, true);

    const memberAfter = env.auth.getMemberById(alice.member.id)!;
    assert.equal(memberAfter.state, 'withdrawn');
    assert.ok(memberAfter.withdrawnAt);
    assert.ok(memberAfter.piiPurgeAt);

    // Sessions, focus, grants closed/revoked
    assert.equal(env.presence.listMemberActiveSessions(alice.member.id).length, 0);
    assert.equal(env.worldDb.db.prepare('SELECT ended_at FROM focus_sessions WHERE member_id = ?').get(alice.member.id)?.ended_at !== null, true);
    assert.ok((env.worldDb.db.prepare('SELECT revoked_at FROM integration_grants WHERE id = ?').get(grantId) as { revoked_at: string | null }).revoked_at);

    // Personal data deleted
    assert.equal(env.worldDb.db.prepare('SELECT COUNT(*) AS c FROM profiles WHERE member_id = ?').get(alice.member.id)?.c, 0);
    assert.equal(env.worldDb.db.prepare('SELECT COUNT(*) AS c FROM personal_spaces WHERE member_id = ?').get(alice.member.id)?.c, 0);
    assert.equal(env.worldDb.db.prepare('SELECT COUNT(*) AS c FROM recruitment_bookmarks WHERE member_id = ?').get(alice.member.id)?.c, 0);
    assert.equal(env.worldDb.db.prepare('SELECT COUNT(*) AS c FROM recovery_credentials WHERE member_id = ?').get(alice.member.id)?.c, 0);

    // Authored content anonymized & archived guestbook preserved with target_space_id = NULL
    assert.equal(env.board.getPost(post.id).authorMemberId, null);
    assert.equal(env.board.getPost(post.id).authorNickname, '탈퇴한 사용자');
    assert.equal(env.board.getPost(post.id).comments[0]?.id, comment.id);
    assert.equal(env.board.getPost(post.id).comments[0]?.authorMemberId, null);
    assert.equal(env.guestbook.listArchivedEntries().find(e => e.id === gbOnAlice.id)?.targetSpaceId, null);
    assert.equal(env.guestbook.listEntries(bob.personalSpace.id).find(e => e.id === gbByAlice.id)?.authorMemberId, null);
    assert.equal(env.chat.listRecentMessages().find(m => m.id === chatMsg.id)?.authorMemberId, null);

    // 90-day name reservations block reuse
    assert.throws(
      () => env.auth.signup({ loginId: 'alice_01', nickname: '새닉네임', password: 'Password!23' }),
      (err: unknown) => err instanceof ServiceError && err.code === 'CONFLICT',
    );
    assert.throws(
      () => env.auth.signup({ loginId: 'NewLogin_01', nickname: '앨리스', password: 'Password!23' }),
      (err: unknown) => err instanceof ServiceError && err.code === 'CONFLICT',
    );

    // Tombstone appended
    const tombstones = env.worldDb.readTombstoneLog();
    assert.ok(tombstones.some(t => t.kind === 'withdraw_member' && t.targetId === alice.member.id));
  } finally {
    env.worldDb.close();
  }
});

test('ModerationService enforces duplicate dedup, 30-per-180s rate limit, live admin check, cascade delete without body copy, and 90d expiry', () => {
  const env = createTestEnv('2026-11-28T01:00:00.000Z');
  try {
    const reporter = env.auth.signup({ loginId: 'rep_01', nickname: '신고자', password: 'Password!23' }).member;
    const author = env.auth.signup({ loginId: 'auth_02', nickname: '작성자', password: 'Password!23' }).member;
    const admin = env.auth.setMemberRole(
      env.auth.signup({ loginId: 'adm_03', nickname: '관리자', password: 'Password!23' }).member.id,
      'admin',
    );

    const posts = Array.from({ length: 32 }, (_, idx) =>
      env.board.createPost(author.id, { boardId: 'free', title: `글 ${idx}`, body: `본문 ${idx}` }),
    );
    const commentOnFirst = env.board.createComment(author.id, { postId: posts[0]!.id, body: '삭제될 댓글' });

    // 1st report succeeds
    const r1 = env.moderation.createReport({
      reporterMemberId: reporter.id,
      targetKind: 'post',
      targetId: posts[0]!.id,
      reason: '스팸 게시물이에요.',
    });
    assert.equal(r1.reviewState, 'received');

    // Duplicate report rejected WITHOUT incrementing rate limit (count stays 1)
    assert.throws(
      () => env.moderation.createReport({
        reporterMemberId: reporter.id,
        targetKind: 'post',
        targetId: posts[0]!.id,
        reason: '중복 신고',
      }),
      (err: unknown) => err instanceof ServiceError && err.code === 'CONFLICT',
    );
    const rateAfterDup = env.worldDb.db.prepare('SELECT count FROM report_rate_limits WHERE member_id = ?').get(reporter.id) as { count: number };
    assert.equal(rateAfterDup.count, 1);

    // Non-existent target rejected WITHOUT incrementing rate limit
    assert.throws(
      () => env.moderation.createReport({
        reporterMemberId: reporter.id,
        targetKind: 'post',
        targetId: 'missing-post-id',
        reason: '없는 글',
      }),
      (err: unknown) => err instanceof ServiceError && err.code === 'NOT_FOUND',
    );
    assert.equal((env.worldDb.db.prepare('SELECT count FROM report_rate_limits WHERE member_id = ?').get(reporter.id) as { count: number }).count, 1);

    // Reports 2..30 succeed
    for (let i = 1; i < 30; i += 1) {
      env.moderation.createReport({
        reporterMemberId: reporter.id,
        targetKind: 'post',
        targetId: posts[i]!.id,
        reason: `신고 ${i + 1}`,
      });
    }
    assert.equal((env.worldDb.db.prepare('SELECT count FROM report_rate_limits WHERE member_id = ?').get(reporter.id) as { count: number }).count, 30);

    // 31st report within 180s is rejected with RATE_LIMITED without mutating counter
    assert.throws(
      () => env.moderation.createReport({
        reporterMemberId: reporter.id,
        targetKind: 'post',
        targetId: posts[30]!.id,
        reason: '한도 초과',
      }),
      (err: unknown) => err instanceof ServiceError && err.code === 'RATE_LIMITED',
    );
    assert.equal((env.worldDb.db.prepare('SELECT count FROM report_rate_limits WHERE member_id = ?').get(reporter.id) as { count: number }).count, 30);

    // After 180 seconds, window resets to 0 and report #31 succeeds
    env.clock.advanceSeconds(180);
    const r31 = env.moderation.createReport({
      reporterMemberId: reporter.id,
      targetKind: 'post',
      targetId: posts[30]!.id,
      reason: '창 초기화 후 신고',
    });
    assert.equal(r31.reviewState, 'received');
    assert.equal((env.worldDb.db.prepare('SELECT count FROM report_rate_limits WHERE member_id = ?').get(reporter.id) as { count: number }).count, 1);

    // Admin lists and reviews r1 with 'deleted' -> cascades post comments, inserts moderation_deletions (no body), appends tombstone
    const pending = env.moderation.listReportsForAdmin(admin.id, 'received');
    assert.equal(pending.length, 31);

    const reviewed = env.moderation.reviewReport({
      adminMemberId: admin.id,
      reportId: r1.id,
      outcome: 'deleted',
      resolutionReason: '운영 정책 위반으로 삭제',
    });
    assert.equal(reviewed.report.reviewState, 'reviewed');
    assert.equal(reviewed.report.outcome, 'deleted');
    assert.equal(reviewed.report.expiresAt, addDays(reviewed.report.reviewedAt!, 90));
    assert.ok(reviewed.deletion);

    // Post and its comment are both soft-deleted
    assert.throws(() => env.board.getPost(posts[0]!.id), (err: unknown) => err instanceof ServiceError && err.code === 'NOT_FOUND');
    const commentRow = env.worldDb.db.prepare('SELECT deleted_at FROM comments WHERE id = ?').get(commentOnFirst.id) as { deleted_at: string | null };
    assert.ok(commentRow.deleted_at);

    // Reporter sees result in listMyReports
    const myReports = env.moderation.listMyReports(reporter.id);
    assert.equal(myReports.find(r => r.id === r1.id)?.outcome, 'deleted');

    // Deletion history has NO content body copy
    const deletions = env.moderation.listDeletionHistory(admin.id);
    assert.equal(deletions.length, 1);
    assert.equal('body' in deletions[0]!, false);

    // Revoking admin role immediately blocks admin operations
    env.auth.setMemberRole(admin.id, 'member');
    assert.throws(
      () => env.moderation.listReportsForAdmin(admin.id),
      (err: unknown) => err instanceof ServiceError && err.code === 'FORBIDDEN',
    );
    assert.throws(
      () => env.moderation.reviewReport({
        adminMemberId: admin.id,
        reportId: r31.id,
        outcome: 'no_action',
        resolutionReason: '권한 회수 테스트',
      }),
      (err: unknown) => err instanceof ServiceError && err.code === 'FORBIDDEN',
    );
    assert.throws(
      () => env.moderation.adminDeleteContent({
        adminMemberId: admin.id,
        targetKind: 'post',
        targetId: posts[31]!.id,
        reason: '권한 회수 테스트',
      }),
      (err: unknown) => err instanceof ServiceError && err.code === 'FORBIDDEN',
    );
  } finally {
    env.worldDb.close();
  }
});

test('RetentionService sweeps expired data, purges 90d withdrawn PII enabling name reuse, rotates 7d backups, and replays tombstones on restore', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'tw-retention-test-'));
  const dataDir = join(rootDir, 'live-data');
  const backupDir = join(rootDir, 'backups');
  const restoreDir = join(rootDir, 'restored-data');

  const env = createTestEnv('2026-11-01T00:00:00.000Z', { dataDir });
  try {
    const alice = env.auth.signup({ loginId: 'Reuse_Id', nickname: '재사용닉', password: 'Password!23' });
    const bob = env.auth.signup({ loginId: 'Bob_Admin', nickname: '관리자밥', password: 'Password!23' });
    const admin = env.auth.setMemberRole(bob.member.id, 'admin');

    const postBeforeBackup = env.board.createPost(alice.member.id, { boardId: 'free', title: '백업 전 글', body: '본문' });
    const chatBeforeBackup = env.chat.sendMessage({ memberId: alice.member.id, body: '14일 뒤 만료될 채팅' });
    env.board.createPost(bob.member.id, { boardId: 'free', title: '멱등 글', body: '멱등 본문', idempotencyKey: 'idem-1' });

    // Create daily backup on 2026-11-01 BEFORE deletion & withdrawal
    const day1Backup = env.retention.createDailyBackup(backupDir);
    assert.equal(day1Backup.fileName, 'world-20261101.db');
    assert.ok(existsSync(day1Backup.backupPath));

    // After backup: report & delete post, send another chat, withdraw alice
    const report = env.moderation.createReport({
      reporterMemberId: alice.member.id,
      targetKind: 'post',
      targetId: postBeforeBackup.id,
      reason: '삭제 테스트',
    });
    env.moderation.reviewReport({
      adminMemberId: admin.id,
      reportId: report.id,
      outcome: 'deleted',
      resolutionReason: '백업 이후 삭제',
    });
    env.lifecycle.withdrawAccount({
      memberId: alice.member.id,
      password: 'Password!23',
      confirm: true,
    });

    // Insert privacy deletion request completed at day 0
    env.worldDb.db.prepare(`
      INSERT INTO privacy_deletion_requests (id, target_kind, target_id, verification_note, status, outcome, reason, received_at, completed_at, expires_at)
      VALUES ('priv-1', 'post', ?, 'verified', 'completed', 'deleted', '요청 삭제', ?, ?, ?)
    `).run(postBeforeBackup.id, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', addDays('2026-11-01T00:00:00.000Z', 90));

    // Advance 25 hours -> idempotency_keys (24h) expires
    env.clock.advanceHours(25);
    const sweep25h = env.retention.runRetentionSweep();
    assert.equal(sweep25h.deletedIdempotencyKeys, 1);
    assert.equal(sweep25h.deletedChatMessages, 0);

    // Advance to day 14 -> chat_messages & operational_logs expire (14d), backup pruning check at day 10
    env.clock.set('2026-11-15T01:00:00.000Z');
    const backupDay15 = env.retention.createDailyBackup(backupDir);
    assert.equal(backupDay15.fileName, 'world-20261115.db');
    // Day 1 backup (14 days old) should be pruned (>7d)
    assert.ok(backupDay15.prunedFiles.includes('world-20261101.db'));
    assert.deepEqual(readdirSync(backupDir), ['world-20261115.db']);

    const sweep14d = env.retention.runRetentionSweep();
    assert.equal(sweep14d.deletedChatMessages, 1);
    assert.ok(sweep14d.deletedOperationalLogs >= 1);

    // Create a fresh pre-withdrawal/pre-deletion snapshot on another temp path to verify restoreFromBackup replay
    const snapEnv = createTestEnv('2026-11-01T00:00:00.000Z');
    const preSnapBackupPath = join(rootDir, 'pre-change-snap.db');
    try {
      const m1 = snapEnv.auth.signup({ loginId: 'SnapUser', nickname: '스냅유저', password: 'Password!23' });
      const m2 = snapEnv.auth.setMemberRole(
        snapEnv.auth.signup({ loginId: 'SnapAdmin', nickname: '스냅관리', password: 'Password!23' }).member.id,
        'admin',
      );
      const p1 = snapEnv.board.createPost(m1.member.id, { boardId: 'free', title: '복구 후 부활 금지 글', body: '내용' });
      const c1 = snapEnv.board.createComment(m1.member.id, { postId: p1.id, body: '복구 후 부활 금지 댓글' });
      const ch1 = snapEnv.chat.sendMessage({ memberId: m1.member.id, body: '만료 채팅' });
      snapEnv.worldDb.backupTo(preSnapBackupPath);

      // Perform actual deletion + withdrawal with tombstoneLogPath pointing to restoreDir/tombstones.log
      mkdirSync(restoreDir, { recursive: true });
      const logPath = join(restoreDir, 'tombstones.log');
      const mutDb = new WorldDatabase({
        dbPath: join(rootDir, 'mutated.db'),
        tombstoneLogPath: logPath,
      });
      try {
        mutDb.appendTombstone({
          recordedAt: '2026-11-02T00:00:00.000Z',
          kind: 'delete_content',
          targetKind: 'post',
          targetId: p1.id,
          payload: { reason: 'admin delete' },
        });
        mutDb.appendTombstone({
          recordedAt: '2026-11-03T00:00:00.000Z',
          kind: 'withdraw_member',
          targetKind: 'member',
          targetId: m1.member.id,
          payload: {
            withdrawnAt: '2026-11-03T00:00:00.000Z',
            piiPurgeAt: addDays('2026-11-03T00:00:00.000Z', 90),
            loginIdKey: m1.member.loginIdKey,
            nicknameKey: m1.member.nicknameKey,
          },
        });
      } finally {
        mutDb.close();
      }

      // Restore pre-change snapshot at day 20 (so ch1 14d expired + tombstones replay post deletion & withdrawal)
      const restoreRetention = new RetentionService(snapEnv.worldDb, new FakeClock('2026-11-21T00:00:00.000Z'));
      const restored = restoreRetention.restoreFromBackup(preSnapBackupPath, restoreDir);
      assert.equal(restored.ready, true);
      assert.equal(restored.replayedTombstones, 2);
      assert.equal(restored.sweepResult.deletedChatMessages, 1);

      const reopened = new WorldDatabase({ dbPath: restored.dbPath, dataDir: restoreDir });
      try {
        // Deleted post & its comment did NOT resurrect
        const postRow = reopened.db.prepare('SELECT deleted_at, author_member_id FROM posts WHERE id = ?').get(p1.id) as { deleted_at: string | null; author_member_id: string | null };
        assert.ok(postRow.deleted_at);
        assert.equal(postRow.author_member_id, null);
        const commentRow = reopened.db.prepare('SELECT deleted_at FROM comments WHERE id = ?').get(c1.id) as { deleted_at: string | null };
        assert.ok(commentRow.deleted_at);

        // Expired chat message did NOT resurrect
        const chatRow = reopened.db.prepare('SELECT id FROM chat_messages WHERE id = ?').get(ch1.id);
        assert.equal(chatRow, undefined);

        // Withdrawn member stayed withdrawn & name reservation is active
        const m1Row = reopened.db.prepare('SELECT state FROM members WHERE id = ?').get(m1.member.id) as { state: string };
        assert.equal(m1Row.state, 'withdrawn');
        assert.equal(reopened.db.prepare('SELECT COUNT(*) AS c FROM personal_spaces WHERE member_id = ?').get(m1.member.id)?.c, 0);
        assert.equal(m2.role, 'admin');
      } finally {
        reopened.close();
      }
    } finally {
      snapEnv.worldDb.close();
    }

    // Advance 90 days after alice's withdrawal -> PII purge removes member row & reservations, allowing reuse
    env.clock.set(addDays('2026-11-01T00:00:00.000Z', 91));
    const sweep90d = env.retention.runRetentionSweep();
    assert.equal(sweep90d.deletedContentReports, 1);
    assert.equal(sweep90d.deletedModerationDeletions, 1);
    assert.equal(sweep90d.deletedPrivacyRequests, 1);
    assert.equal(sweep90d.purgedWithdrawnMembers, 1);

    // Members row removed & dedup keys removed
    assert.equal(env.auth.getMemberById(alice.member.id), null);
    assert.equal(
      (env.worldDb.db.prepare('SELECT COUNT(*) AS c FROM report_dedup_keys WHERE reporter_member_id = ?').get(alice.member.id) as { c: number }).c,
      0,
    );
    assert.ok(
      env.worldDb.readTombstoneLog().some(t => t.kind === 'purge_member_pii' && t.targetId === alice.member.id),
    );

    // loginId and nickname can now be reused after 90 days
    const reused = env.auth.signup({
      loginId: 'Reuse_Id',
      nickname: '재사용닉',
      password: 'Password!23',
    });
    assert.notEqual(reused.member.id, alice.member.id);
    assert.equal(chatBeforeBackup.authorMemberId, alice.member.id);
  } finally {
    env.worldDb.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('AccountSecurityScreen and AdminPanelScreen render cleanly and support Escape back navigation', async () => {
  const env = createTestEnv('2026-11-28T01:00:00.000Z');
  try {
    const member = env.auth.signup({ loginId: 'tui_user', nickname: '화면유저', password: 'Password!23' }).member;
    const admin = env.auth.setMemberRole(
      env.auth.signup({ loginId: 'tui_admin', nickname: '화면관리자', password: 'Password!23' }).member.id,
      'admin',
    );
    const post = env.board.createPost(member.id, { boardId: 'free', title: '테스트 글', body: '테스트 본문' });
    env.moderation.createReport({
      reporterMemberId: member.id,
      targetKind: 'post',
      targetId: post.id,
      reason: '화면 테스트 신고',
    });

    const mountAndTest = async (element: ReturnType<typeof createElement>, isBacked: () => boolean) => {
      let output = '';
      const stdin = Object.assign(new PassThrough(), {
        isTTY: true,
        setRawMode() { return this; },
        ref() { return this; },
        unref() { return this; },
      });
      const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 28 });
      stdout.on('data', (chunk) => {
        output += String(chunk).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
      });
      const inst = render(element, {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
      });
      await new Promise(resolve => setTimeout(resolve, 40));
      stdin.write('\u001b');
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.equal(isBacked(), true);
      inst.unmount();
      return output;
    };

    let backed1 = false;
    const accountText = await mountAndTest(
      createElement(AccountSecurityScreen, {
        lifecycleService: env.lifecycle,
        moderationService: env.moderation,
        memberId: member.id,
        nickname: member.nickname,
        onBack: () => { backed1 = true; },
      }),
      () => backed1,
    );
    assert.match(accountText, /계정 · 보안 · 연동 관리/);

    let backed2 = false;
    const adminText = await mountAndTest(
      createElement(AdminPanelScreen, {
        moderationService: env.moderation,
        adminMemberId: admin.id,
        adminNickname: admin.nickname,
        onBack: () => { backed2 = true; },
      }),
      () => backed2,
    );
    assert.match(adminText, /관리자 패널/);
    assert.match(adminText, /화면 테스트 신고/);
  } finally {
    env.worldDb.close();
  }
});
