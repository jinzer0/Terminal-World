import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import { render } from 'ink';
import { AuthService } from '../src/core/auth-service.js';
import { BOARD_IDS, BoardService, WITHDRAWN_AUTHOR_LABEL } from '../src/core/board-service.js';
import { FakeClock } from '../src/core/clock.js';
import { ServiceError } from '../src/core/errors.js';
import { NoticeService } from '../src/core/notice-service.js';
import { RecruitmentService } from '../src/core/recruitment-service.js';
import { WorldDatabase } from '../src/store/sqlite/database.js';
import { CafeScreen } from '../src/tui/screens/CafeScreen.js';
import { LobbyScreen } from '../src/tui/screens/LobbyScreen.js';
import { RecruitmentScreen } from '../src/tui/screens/RecruitmentScreen.js';

function setupCommunity(initialIso = '2026-11-28T01:00:00.000Z') {
  const clock = new FakeClock(initialIso);
  const worldDb = new WorldDatabase({ dbPath: ':memory:' });
  const auth = new AuthService(worldDb, clock);
  const boards = new BoardService(worldDb, clock);
  const recruitments = new RecruitmentService(worldDb, clock);
  const notices = new NoticeService(worldDb, clock);

  const alice = auth.signup({ loginId: 'alice01', nickname: '앨리스', password: 'Password!23' }).member;
  const bob = auth.signup({ loginId: 'bob02', nickname: '밥개발', password: 'Password!23' }).member;
  const admin = auth.setMemberRole(
    auth.signup({ loginId: 'admin01', nickname: '운영자', password: 'Password!23' }).member.id,
    'admin',
  );

  return { clock, worldDb, auth, boards, recruitments, notices, alice, bob, admin };
}

test('all 7 fixed boards support post creation, cursor pagination, and guest read access', () => {
  const { clock, worldDb, boards, alice } = setupCommunity();
  try {
    const allBoards = boards.listBoards();
    assert.deepEqual(
      allBoards.map(b => b.id),
      [...BOARD_IDS],
    );

    // Create a post in each of the 7 boards
    for (const boardId of BOARD_IDS) {
      const created = boards.createPost(alice.id, {
        boardId,
        title: `${boardId} 제목`,
        body: `${boardId} 본문 내용`,
      });
      assert.equal(created.boardId, boardId);
      assert.equal(created.authorNickname, '앨리스');
    }

    // Cursor pagination with identical timestamps in 'free' board
    const createdIds: string[] = [];
    for (let i = 1; i <= 4; i += 1) {
      const post = boards.createPost(alice.id, {
        boardId: 'free',
        title: `자유 글 ${i}`,
        body: `본문 ${i}`,
      });
      createdIds.push(post.id);
      clock.advanceSeconds(1);
    }

    const page1 = boards.listPosts({ boardId: 'free', limit: 2 });
    assert.equal(page1.items.length, 2);
    assert.equal(page1.hasMore, true);
    assert.ok(page1.cursor);

    const page2 = boards.listPosts({ boardId: 'free', limit: 2, cursor: page1.cursor });
    assert.equal(page2.items.length, 2);
    assert.equal(page2.hasMore, true);

    const page3 = boards.listPosts({ boardId: 'free', limit: 2, cursor: page2.cursor });
    assert.equal(page3.items.length, 1);
    assert.equal(page3.hasMore, false);
    assert.equal(page3.cursor, null);

    // Combined pages contain all 5 distinct posts in 'free'
    const allIds = [...page1.items, ...page2.items, ...page3.items].map(p => p.id);
    assert.equal(new Set(allIds).size, 5);

    assert.throws(
      () => boards.listPosts({ boardId: 'unknown-board' }),
      (err: unknown) => err instanceof ServiceError && err.code === 'NOT_FOUND',
    );
    assert.throws(
      () => boards.listPosts({ boardId: 'free', cursor: 'bad-cursor' }),
      (err: unknown) => err instanceof ServiceError && err.code === 'INVALID_INPUT',
    );
  } finally {
    worldDb.close();
  }
});

test('post and comment CRUD, permissions, cascade delete, withdrawn author display, and idempotency', () => {
  const { clock, worldDb, boards, alice, bob, admin } = setupCommunity();
  try {
    // Guest cannot write
    assert.throws(
      () => boards.createPost(null, { boardId: 'dev-qna', title: '게스트', body: '불가' }),
      (err: unknown) => err instanceof ServiceError && err.code === 'UNAUTHORIZED',
    );

    // Idempotent post creation
    const p1 = boards.createPost(alice.id, {
      boardId: 'dev-qna',
      title: 'Node SQLite 질문',
      body: 'WAL 모드 질문입니다.',
      idempotencyKey: 'post-key-1',
    });
    const p1Retry = boards.createPost(alice.id, {
      boardId: 'dev-qna',
      title: 'Node SQLite 질문',
      body: 'WAL 모드 질문입니다.',
      idempotencyKey: 'post-key-1',
    });
    assert.equal(p1Retry.id, p1.id);

    // Same idempotency key with different payload -> CONFLICT
    assert.throws(
      () =>
        boards.createPost(alice.id, {
          boardId: 'dev-qna',
          title: '다른 제목',
          body: 'WAL 모드 질문입니다.',
          idempotencyKey: 'post-key-1',
        }),
      (err: unknown) => err instanceof ServiceError && err.code === 'CONFLICT',
    );

    // Update post: author only (admin cannot edit another member's post)
    assert.throws(
      () => boards.updatePost(admin.id, p1.id, { title: '운영자 수정' }),
      (err: unknown) => err instanceof ServiceError && err.code === 'FORBIDDEN',
    );
    const updatedPost = boards.updatePost(alice.id, p1.id, { title: '수정된 질문' });
    assert.equal(updatedPost.title, '수정된 질문');

    // Comments CRUD + idempotency
    const c1 = boards.createComment(bob.id, {
      postId: p1.id,
      body: '첫 댓글입니다.',
      idempotencyKey: 'comment-key-1',
    });
    const c1Retry = boards.createComment(bob.id, {
      postId: p1.id,
      body: '첫 댓글입니다.',
      idempotencyKey: 'comment-key-1',
    });
    assert.equal(c1Retry.id, c1.id);

    const c2 = boards.createComment(alice.id, {
      postId: p1.id,
      body: '답변 감사합니다!',
    });

    // Non-author cannot update comment
    assert.throws(
      () => boards.updateComment(alice.id, c1.id, { body: '남의 댓글 수정' }),
      (err: unknown) => err instanceof ServiceError && err.code === 'FORBIDDEN',
    );
    const c1Updated = boards.updateComment(bob.id, c1.id, { body: '수정된 댓글입니다.' });
    assert.equal(c1Updated.body, '수정된 댓글입니다.');

    // Simulate bob withdrawal -> authorNickname becomes '탈퇴한 사용자'
    worldDb.db.prepare("UPDATE members SET state = 'withdrawn' WHERE id = ?").run(bob.id);
    const detailAfterWithdraw = boards.getPost(p1.id);
    assert.equal(detailAfterWithdraw.comments.length, 2);
    assert.equal(detailAfterWithdraw.comments[0]!.authorNickname, WITHDRAWN_AUTHOR_LABEL);
    assert.equal(detailAfterWithdraw.comments[1]!.authorNickname, '앨리스');

    // Non-admin member cannot delete another's post
    const charlie = new AuthService(worldDb, clock).signup({
      loginId: 'charlie03',
      nickname: '찰리',
      password: 'Password!23',
    }).member;
    assert.throws(
      () => boards.deletePost(charlie.id, p1.id),
      (err: unknown) => err instanceof ServiceError && err.code === 'FORBIDDEN',
    );

    // Admin deletes post -> cascades soft-delete to all remaining comments & records moderation_deletions
    const delResult = boards.deletePost(admin.id, p1.id, { reason: '스팸 테스트 삭제' });
    assert.equal(delResult.deletedPostId, p1.id);
    assert.equal(delResult.deletedCommentCount, 2);

    assert.throws(
      () => boards.getPost(p1.id),
      (err: unknown) => err instanceof ServiceError && err.code === 'NOT_FOUND',
    );

    // No orphan non-deleted comments remain in SQLite
    const orphanComments = worldDb.db
      .prepare('SELECT COUNT(*) AS cnt FROM comments WHERE post_id = ? AND deleted_at IS NULL')
      .get(p1.id) as { cnt: number };
    assert.equal(orphanComments.cnt, 0);

    // Cannot comment on deleted post
    assert.throws(
      () => boards.createComment(alice.id, { postId: p1.id, body: '고아 댓글 시도' }),
      (err: unknown) => err instanceof ServiceError && err.code === 'NOT_FOUND',
    );
    void c2;

    const modRows = worldDb.db
      .prepare("SELECT target_kind, target_id, reason FROM moderation_deletions WHERE target_id = ?")
      .all(p1.id) as Array<{ target_kind: string; target_id: string; reason: string }>;
    assert.equal(modRows.length, 1);
    assert.equal(modRows[0]!.reason, '스팸 테스트 삭제');
  } finally {
    worldDb.close();
  }
});

test('recruitment validates FR-31 fields, enforces KST auto-close, supports filters, and manages private bookmarks', () => {
  const { clock, worldDb, boards, recruitments, alice, bob, admin } = setupCommunity(
    '2026-12-01T14:59:58.000Z', // 2026-12-01 23:59:58 KST
  );
  try {
    // Missing ackPublic -> rejected
    assert.throws(
      () =>
        recruitments.createRecruitment(alice.id, {
          title: '팀원 모집',
          body: '같이 만들어요',
          recruitmentType: 'project',
          progressNote: '기획 완료',
          roles: ['Backend'],
          requiredSkills: ['TypeScript'],
          participationPeriod: '2개월',
          weeklyTime: '주 10시간',
          participationMode: 'online',
          contactMethod: 'https://example.com/apply',
          deadlineAt: '2026-12-01',
          ackPublic: false,
        }),
      (err: unknown) => err instanceof ServiceError && err.code === 'INVALID_INPUT' && err.field === 'ackPublic',
    );

    // Offline/hybrid without region -> rejected
    assert.throws(
      () =>
        recruitments.createRecruitment(alice.id, {
          title: '오프라인 모집',
          body: '서울 모임',
          recruitmentType: 'hackathon',
          progressNote: '아이디어 단계',
          roles: ['Frontend'],
          noSkillRequired: true,
          participationPeriod: '1주',
          weeklyTime: '주말 12시간',
          participationMode: 'offline',
          contactMethod: 'email: team@example.com',
          deadlineAt: '2026-12-05',
          ackPublic: true,
        }),
      (err: unknown) => err instanceof ServiceError && err.code === 'INVALID_INPUT' && err.field === 'region',
    );

    // Missing skills when noSkillRequired is false -> rejected
    assert.throws(
      () =>
        recruitments.createRecruitment(alice.id, {
          title: '기술 누락',
          body: '본문',
          recruitmentType: 'contest',
          progressNote: '초기',
          roles: ['Designer'],
          requiredSkills: [],
          noSkillRequired: false,
          participationPeriod: '1개월',
          weeklyTime: '주 5시간',
          participationMode: 'online',
          contactMethod: 'discord',
          deadlineAt: '2026-12-05',
          ackPublic: true,
        }),
      (err: unknown) => err instanceof ServiceError && err.code === 'INVALID_INPUT' && err.field === 'requiredSkills',
    );

    // Valid creation: deadlineAt '2026-12-01' => 2026-12-01T14:59:59.999Z (KST end of day)
    const r1 = recruitments.createRecruitment(alice.id, {
      title: 'KST 마감 프로젝트',
      body: 'TypeScript 백엔드 모집',
      recruitmentType: 'project',
      progressNote: 'MVP 개발 중',
      roles: ['Backend', 'Infra'],
      requiredSkills: ['TypeScript', 'SQLite'],
      participationPeriod: '3개월',
      weeklyTime: '주 8시간',
      participationMode: 'online',
      contactMethod: 'https://example.com/recruit-1',
      deadlineAt: '2026-12-01',
      ackPublic: true,
    });
    assert.equal(r1.deadlineAt, '2026-12-01T14:59:59.999Z');
    assert.equal(r1.recruitmentState, 'open');

    const r2 = recruitments.createRecruitment(bob.id, {
      title: '오프라인 해커톤',
      body: '서울 강남 해커톤 팀원 모집',
      recruitmentType: 'hackathon',
      progressNote: '팀 빌딩 중',
      roles: ['Frontend'],
      noSkillRequired: true,
      participationPeriod: '48시간',
      weeklyTime: '집중 48시간',
      participationMode: 'hybrid',
      region: '서울 강남',
      contactMethod: 'openchat: example',
      deadlineAt: '2026-12-10T18:00',
      ackPublic: true,
    });
    assert.equal(r2.deadlineAt, '2026-12-10T09:00:00.000Z');
    assert.equal(r2.noSkillRequired, true);
    assert.equal(r2.region, '서울 강남');

    // Filter search before deadline expires
    const byType = recruitments.searchRecruitments({ type: 'project' });
    assert.deepEqual(byType.items.map(i => i.id), [r1.id]);

    const bySkill = recruitments.searchRecruitments({ skill: 'sqlite' });
    assert.deepEqual(bySkill.items.map(i => i.id), [r1.id]);

    const byRole = recruitments.searchRecruitments({ role: 'frontend' });
    assert.deepEqual(byRole.items.map(i => i.id), [r2.id]);

    const byMode = recruitments.searchRecruitments({ mode: 'hybrid' });
    assert.deepEqual(byMode.items.map(i => i.id), [r2.id]);

    // Private bookmarks: Bob bookmarks r1, Alice cannot read Bob's bookmarks
    recruitments.addBookmark(bob.id, r1.id);
    recruitments.addBookmark(bob.id, r1.id); // idempotent duplicate check
    const bobBookmarks = recruitments.listMyBookmarks(bob.id);
    assert.equal(bobBookmarks.length, 1);
    assert.equal(bobBookmarks[0]!.id, r1.id);
    assert.equal(bobBookmarks[0]!.recruitmentState, 'open');

    assert.equal(recruitments.listMyBookmarks(alice.id).length, 0);
    assert.throws(
      () => recruitments.listMyBookmarks(admin.id, bob.id),
      (err: unknown) => err instanceof ServiceError && err.code === 'FORBIDDEN',
    );

    // Advance clock to 2026-12-01 23:59:59.999 KST -> r1 auto-closes!
    clock.set('2026-12-01T14:59:59.999Z');
    const r1AfterDeadline = recruitments.getRecruitment(r1.id, bob.id);
    assert.equal(r1AfterDeadline.recruitmentState, 'closed');
    assert.equal(r1AfterDeadline.isBookmarked, true);

    const openList = recruitments.searchRecruitments({ state: 'open' });
    assert.deepEqual(openList.items.map(i => i.id), [r2.id]);
    const closedList = recruitments.searchRecruitments({ state: 'closed' });
    assert.deepEqual(closedList.items.map(i => i.id), [r1.id]);

    // Bookmark list reflects closed state
    assert.equal(recruitments.listMyBookmarks(bob.id)[0]!.recruitmentState, 'closed');

    // Manual close by non-author rejected, by author succeeds
    assert.throws(
      () => recruitments.closeRecruitment(alice.id, r2.id),
      (err: unknown) => err instanceof ServiceError && err.code === 'FORBIDDEN',
    );
    const r2Closed = recruitments.closeRecruitment(bob.id, r2.id);
    assert.equal(r2Closed.recruitmentState, 'closed');

    // Deleting r1 removes bookmarks and blocks re-bookmarking
    boards.deletePost(alice.id, r1.id);
    assert.equal(recruitments.listMyBookmarks(bob.id).length, 0);
    assert.throws(
      () => recruitments.setBookmark(bob.id, r1.id, true),
      (err: unknown) => err instanceof ServiceError && err.code === 'NOT_FOUND',
    );

    // Remove bookmark on r2
    recruitments.addBookmark(alice.id, r2.id);
    assert.equal(recruitments.listMyBookmarks(alice.id).length, 1);
    recruitments.removeBookmark(alice.id, r2.id);
    assert.equal(recruitments.listMyBookmarks(alice.id).length, 0);
  } finally {
    worldDb.close();
  }
});

test('notices enforce live admin verification inside BEGIN IMMEDIATE and support public reading', () => {
  const { worldDb, auth, notices, alice, admin } = setupCommunity();
  try {
    // Non-admin & guest cannot create notices
    assert.throws(
      () => notices.createNotice(null, { title: '게스트 공지', body: '불가' }),
      (err: unknown) => err instanceof ServiceError && err.code === 'UNAUTHORIZED',
    );
    assert.throws(
      () => notices.createNotice(alice.id, { title: '일반 공지', body: '불가' }),
      (err: unknown) => err instanceof ServiceError && err.code === 'FORBIDDEN',
    );

    // Admin creates, updates, and ends notice
    const n1 = notices.createNotice(admin.id, {
      title: '서버 점검 안내',
      body: '오늘 자정 점검이 있습니다.',
      idempotencyKey: 'notice-1',
    });
    const n1Retry = notices.createNotice(admin.id, {
      title: '서버 점검 안내',
      body: '오늘 자정 점검이 있습니다.',
      idempotencyKey: 'notice-1',
    });
    assert.equal(n1Retry.id, n1.id);

    const n1Updated = notices.updateNotice(admin.id, n1.id, {
      title: '서버 점검 시간 변경',
    });
    assert.equal(n1Updated.title, '서버 점검 시간 변경');
    assert.equal(n1Updated.publicationState, 'published');

    // Public list & detail work without login
    const published = notices.listNotices();
    assert.equal(published.items.length, 1);
    assert.equal(notices.getNotice(n1.id).title, '서버 점검 시간 변경');

    const n1Ended = notices.endNotice(admin.id, n1.id);
    assert.equal(n1Ended.publicationState, 'ended');
    assert.ok(n1Ended.endedAt);

    assert.equal(notices.listNotices().items.length, 0);
    assert.equal(notices.listNotices({ includeEnded: true }).items.length, 1);
    assert.equal(notices.listNotices({ state: 'ended' }).items.length, 1);

    // Create another notice then revoke admin role live
    const n2 = notices.createNotice(admin.id, {
      title: '두 번째 공지',
      body: '내용',
    });

    const demoted = auth.setMemberRole(admin.id, 'member');
    assert.equal(demoted.role, 'member');

    // Immediately rejected inside BEGIN IMMEDIATE even using the same admin.id
    assert.throws(
      () => notices.createNotice(admin.id, { title: '회수 후 공지', body: '실패해야 함' }),
      (err: unknown) => err instanceof ServiceError && err.code === 'FORBIDDEN',
    );
    assert.throws(
      () => notices.updateNotice(admin.id, n2.id, { body: '회수 후 수정' }),
      (err: unknown) => err instanceof ServiceError && err.code === 'FORBIDDEN',
    );
    assert.throws(
      () => notices.endNotice(admin.id, n2.id),
      (err: unknown) => err instanceof ServiceError && err.code === 'FORBIDDEN',
    );
  } finally {
    worldDb.close();
  }
});

test('LobbyScreen, CafeScreen, and RecruitmentScreen render cleanly in Ink', async () => {
  const { worldDb, boards, recruitments, notices, alice, admin } = setupCommunity();
  notices.createNotice(admin.id, { title: '환영 공지', body: '반갑습니다.' });
  boards.createPost(alice.id, { boardId: 'free', title: '첫 자유글', body: '안녕하세요' });
  recruitments.createRecruitment(alice.id, {
    title: 'Ink UI 프로젝트',
    body: '함께해요',
    recruitmentType: 'project',
    progressNote: '진행 중',
    roles: ['Frontend'],
    requiredSkills: ['React'],
    participationPeriod: '1개월',
    weeklyTime: '주 5시간',
    participationMode: 'online',
    contactMethod: 'https://example.com',
    deadlineAt: '2026-12-20',
    ackPublic: true,
  });

  const makeStreams = () => {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode() { return this; },
      ref() { return this; },
      unref() { return this; },
    });
    let frame = '';
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 30 });
    stdout.on('data', chunk => {
      frame += String(chunk).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    });
    const stderr = new PassThrough();
    stderr.resume();
    return { stdin, stdout, stderr, text: () => frame };
  };

  try {
    for (const [label, element] of [
      [
        'LobbyScreen',
        createElement(LobbyScreen, {
          noticeService: notices,
          currentMember: admin,
          presence: {
            onlineMembers: [{ memberId: alice.id, nickname: alice.nickname }],
            awayMembers: [],
            guestCount: 1,
          },
          onBack: () => {},
        }),
      ],
      [
        'CafeScreen',
        createElement(CafeScreen, {
          boardService: boards,
          currentMember: alice,
          onBack: () => {},
        }),
      ],
      [
        'RecruitmentScreen',
        createElement(RecruitmentScreen, {
          recruitmentService: recruitments,
          currentMember: alice,
          onBack: () => {},
        }),
      ],
    ] as const) {
      const streams = makeStreams();
      const instance = render(element, {
        stdin: streams.stdin as unknown as NodeJS.ReadStream,
        stdout: streams.stdout as unknown as NodeJS.WriteStream,
        stderr: streams.stderr as unknown as NodeJS.WriteStream,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await delay(30);
      await instance.waitUntilRenderFlush();
      const output = streams.text();
      assert.ok(output.length > 0, `${label} should render output`);
      instance.unmount();
      await instance.waitUntilExit();
      streams.stdin.destroy();
      streams.stdout.destroy();
      streams.stderr.destroy();
    }
  } finally {
    worldDb.close();
  }
});
