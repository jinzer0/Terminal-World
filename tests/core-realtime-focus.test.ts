import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createElement } from 'react';
import { render } from 'ink';
import { AuthService } from '../src/core/auth-service.js';
import { ChatService } from '../src/core/chat-service.js';
import { FakeClock } from '../src/core/clock.js';
import { ServiceError } from '../src/core/errors.js';
import { FocusService } from '../src/core/focus-service.js';
import { PresenceService } from '../src/core/presence-service.js';
import { RealtimeHub, type RealtimeEvent } from '../src/core/realtime-hub.js';
import { WorldDatabase } from '../src/store/sqlite/database.js';
import { FocusScreen } from '../src/tui/screens/FocusScreen.js';
import { LivingRoomScreen } from '../src/tui/screens/LivingRoomScreen.js';
import { RoofTopScreen } from '../src/tui/screens/RoofTopScreen.js';

function setupEnv(initialTime = '2026-11-28T01:00:00.000Z') {
  const clock = new FakeClock(initialTime);
  const worldDb = new WorldDatabase({ dbPath: ':memory:' });
  const hub = new RealtimeHub(clock);
  const auth = new AuthService(worldDb, clock);
  const presence = new PresenceService(worldDb, clock, hub);
  const chat = new ChatService(worldDb, clock, hub);
  const focus = new FocusService(worldDb, clock, hub);
  return { clock, worldDb, hub, auth, presence, chat, focus };
}

test('RealtimeHub delivers typed and wildcard events, supports unsubscribe, and isolates subscriber errors', () => {
  const clock = new FakeClock('2026-11-28T01:00:00.000Z');
  const hub = new RealtimeHub(clock);

  const received: RealtimeEvent[] = [];
  const chatReceived: string[] = [];

  hub.subscribe('chat.message', () => {
    throw new Error('broken subscriber');
  });
  const unsubChat = hub.subscribe('chat.message', (event) => {
    chatReceived.push(event.payload.body);
  });
  const unsubAll = hub.subscribeAll((event) => {
    received.push(event);
  });

  const first = hub.publish('chat.message', {
    id: 'msg-1',
    roomId: 'space:rooftop',
    authorMemberId: 'm1',
    authorNickname: 'Mina',
    body: '안녕하세요',
    sentAt: clock.now().toISOString(),
    expiresAt: '2026-12-12T01:00:00.000Z',
  });
  assert.equal(first.seq, 1);
  assert.deepEqual(chatReceived, ['안녕하세요']);
  assert.equal(received.length, 1);

  unsubChat();
  hub.publish('chat.deleted', {
    id: 'msg-1',
    roomId: 'space:rooftop',
    deletedAt: clock.now().toISOString(),
  });
  assert.equal(received.length, 2);
  assert.equal(received[1]?.seq, 2);

  unsubAll();
  hub.clear();
  assert.equal(hub.listenerCount(), 0);
});

test('2-user RoofTop live chat, guest restriction, idempotency deduplication, 14-day expiry, and admin deletion', () => {
  const { clock, worldDb, hub, auth, chat } = setupEnv('2026-11-28T01:00:00.000Z');
  try {
    const alice = auth.signup({ loginId: 'alice_01', nickname: '앨리스', password: 'Password!23' }).member;
    const bob = auth.signup({ loginId: 'bob_02', nickname: '밥개발', password: 'Password!23' }).member;
    const admin = auth.setMemberRole(
      auth.signup({ loginId: 'admin_03', nickname: '운영자', password: 'Password!23' }).member.id,
      'admin',
    );

    const liveEvents: Array<{ type: string; id: string }> = [];
    const unsub = hub.subscribeMany(['chat.message', 'chat.deleted'], (event) => {
      liveEvents.push({ type: event.type, id: event.payload.id });
    });

    // Guests are forbidden from sending chat messages
    assert.throws(
      () => chat.sendMessage({ memberId: null, body: '게스트 인사' }),
      (err: unknown) => err instanceof ServiceError && err.code === 'FORBIDDEN',
    );

    // Invalid chat input (multiline / empty) rejected
    assert.throws(
      () => chat.sendMessage({ memberId: alice.id, body: '   ' }),
      (err: unknown) => err instanceof ServiceError && err.code === 'INVALID_INPUT',
    );
    assert.throws(
      () => chat.sendMessage({ memberId: alice.id, body: 'line1\nline2' }),
      (err: unknown) => err instanceof ServiceError && err.code === 'INVALID_INPUT',
    );

    // 2-user live chat with idempotency key
    const first = chat.sendMessage({
      memberId: alice.id,
      body: 'RoofTop 첫 메시지!',
      idempotencyKey: 'key-alice-1',
    });
    assert.equal(first.deduplicated, false);
    assert.equal(first.authorNickname, '앨리스');

    // Re-sending with same key & body returns cached message without duplicate row or event
    const retry = chat.sendMessage({
      memberId: alice.id,
      body: 'RoofTop 첫 메시지!',
      idempotencyKey: 'key-alice-1',
    });
    assert.equal(retry.deduplicated, true);
    assert.equal(retry.id, first.id);

    // Re-sending same key with different body fails with CONFLICT
    assert.throws(
      () => chat.sendMessage({
        memberId: alice.id,
        body: '다른 내용',
        idempotencyKey: 'key-alice-1',
      }),
      (err: unknown) => err instanceof ServiceError && err.code === 'CONFLICT',
    );

    const second = chat.sendMessage({
      memberId: bob.id,
      body: '반가워요 앨리스님!',
      idempotencyKey: 'key-bob-1',
    });
    assert.equal(second.deduplicated, false);

    assert.deepEqual(
      liveEvents,
      [
        { type: 'chat.message', id: first.id },
        { type: 'chat.message', id: second.id },
      ],
    );
    assert.equal(chat.listRecentMessages().length, 2);

    // Non-admin cannot delete chat messages
    assert.throws(
      () => chat.deleteMessage(bob.id, first.id, '삭제 시도'),
      (err: unknown) => err instanceof ServiceError && err.code === 'FORBIDDEN',
    );

    // Admin deletes Alice's message -> excluded from history & emits chat.deleted
    const deleted = chat.deleteMessage(admin.id, first.id, '스팸 테스트 삭제');
    assert.equal(deleted.id, first.id);
    assert.deepEqual(liveEvents.at(-1), { type: 'chat.deleted', id: first.id });
    assert.deepEqual(chat.listRecentMessages().map((m) => m.id), [second.id]);

    // Check moderation_deletions and tombstone recorded without message body
    const modRow = worldDb.db.prepare(
      'SELECT target_kind, target_id, reason FROM moderation_deletions WHERE target_id = ?',
    ).get(first.id) as { target_kind: string; target_id: string; reason: string } | undefined;
    assert.equal(modRow?.target_kind, 'chat');
    assert.equal(modRow?.reason, '스팸 테스트 삭제');
    assert.equal(worldDb.readTombstoneLog().length, 1);

    // 14-day retention expiry: advance 13 days -> still visible; advance past 14 days -> expired
    clock.advanceDays(13);
    assert.equal(chat.listRecentMessages().length, 1);

    const freshMsg = chat.sendMessage({ memberId: alice.id, body: '새 메시지' });
    clock.advanceDays(2); // total 15 days from `second`, 2 days from `freshMsg`
    const remaining = chat.listRecentMessages();
    assert.deepEqual(remaining.map((m) => m.id), [freshMsg.id]);

    // Recent 100 cap check
    for (let i = 0; i < 105; i += 1) {
      clock.advanceMs(10);
      chat.sendMessage({ memberId: bob.id, body: `msg-${i}` });
    }
    const capped = chat.listRecentMessages();
    assert.equal(capped.length, 100);
    assert.equal(capped[0]?.body, 'msg-5');
    assert.equal(capped[99]?.body, 'msg-104');

    unsub();
  } finally {
    worldDb.close();
  }
});

test('Multi-session Living Room presence aggregation, lobby overview, and stale session expiration', () => {
  const { clock, worldDb, hub, auth, presence } = setupEnv('2026-11-28T03:00:00.000Z');
  try {
    const mina = auth.signup({ loginId: 'mina_01', nickname: '미나', password: 'Password!23' }).member;
    const jun = auth.signup({ loginId: 'jun_02', nickname: '준영', password: 'Password!23' }).member;

    const presenceEvents: Array<{ memberId: string; status: string; count: number }> = [];
    const sessionEndedEvents: Array<{ sessionId: string; mode: string }> = [];
    hub.subscribe('presence.changed', (e) => {
      presenceEvents.push({
        memberId: e.payload.memberId,
        status: e.payload.status,
        count: e.payload.activeSessionCount,
      });
    });
    hub.subscribe('session.ended', (e) => {
      sessionEndedEvents.push({ sessionId: e.payload.sessionId, mode: e.payload.mode });
    });

    // 0 active sessions -> offline
    assert.equal(presence.getMemberPresence(mina.id).status, 'offline');

    // Open session 1 in lobby -> online
    const s1 = presence.openSession({ memberId: mina.id, channel: 'ssh', spaceId: 'space:lobby' });
    assert.equal(presence.getMemberPresence(mina.id).status, 'online');

    // Move session 1 to Living Room -> all (1/1) in space:living -> away
    presence.moveSpace(s1.id, 'space:living');
    assert.equal(presence.getMemberPresence(mina.id).status, 'away');

    // Open session 2 on CLI in Cafe -> 1 in living + 1 outside -> online!
    const s2 = presence.openSession({ memberId: mina.id, channel: 'cli', spaceId: 'space:cafe' });
    assert.equal(presence.getMemberPresence(mina.id).status, 'online');
    assert.equal(presence.getMemberPresence(mina.id).activeSessionCount, 2);

    // Move session 2 into Living Room -> all (2/2) in space:living -> away
    presence.moveSpace(s2.id, 'space:living');
    assert.equal(presence.getMemberPresence(mina.id).status, 'away');

    // Close session 1 -> session 2 still in Living Room -> remains away
    presence.closeSession(s1.id, { mode: 'normal' });
    assert.equal(presence.getMemberPresence(mina.id).status, 'away');
    assert.equal(presence.getMemberPresence(mina.id).activeSessionCount, 1);

    // Open session for Jun + guest sessions for Lobby overview check
    const junS1 = presence.openSession({ memberId: jun.id, channel: 'ssh', spaceId: 'space:rooftop' });
    const junS2 = presence.openSession({ memberId: jun.id, channel: 'mcp', spaceId: 'space:focus' });
    const guest1 = presence.openSession({ isGuest: true, channel: 'ssh', spaceId: 'space:lobby' });
    const guest2 = presence.openSession({ isGuest: true, channel: 'ssh', spaceId: 'space:cafe' });

    // Move avatar coordinate on Jun's SSH session
    presence.moveAvatar(junS1.id, 24, 9);

    const overview = presence.getLobbyOverview();
    // Each member appears once regardless of multiple sessions
    assert.deepEqual(overview.onlineMembers.map((m) => m.nickname), ['준영']);
    assert.deepEqual(overview.awayMembers.map((m) => m.nickname), ['미나']);
    assert.equal(overview.onlineCount, 1);
    assert.equal(overview.awayCount, 1);
    assert.equal(overview.guestCount, 2);
    assert.equal(overview.activeAvatars.length, 5);

    // Heartbeat junS1 and guest1 at +20s, leave s2, junS2, guest2 stale
    clock.advanceSeconds(20);
    presence.heartbeat(junS1.id);
    presence.heartbeat(guest1.id);

    // Advance 15s (total 35s from start; 15s from junS1/guest1 heartbeat) -> expire timeout 30s
    clock.advanceSeconds(15);
    const expired = presence.expireStaleSessions(30_000);
    assert.deepEqual(
      expired.map((s) => s.id).sort(),
      [s2.id, junS2.id, guest2.id].sort(),
    );

    assert.equal(presence.getMemberPresence(mina.id).status, 'offline');
    assert.equal(presence.getMemberPresence(jun.id).status, 'online');
    assert.equal(presence.getLobbyOverview().guestCount, 1);
    assert.ok(sessionEndedEvents.some((e) => e.sessionId === s2.id && e.mode === 'disconnect'));
    assert.ok(presenceEvents.some((e) => e.memberId === mina.id && e.status === 'offline'));
  } finally {
    worldDb.close();
  }
});

test('Focus Room enforces 1 active per member, start-session vs other-session disconnect, KST midnight split, ties (1,1,3), and history privacy', () => {
  const { clock, worldDb, auth, presence, focus } = setupEnv('2026-11-28T14:55:00.000Z'); // 23:55:00 KST on 2026-11-28
  try {
    const alice = auth.signup({ loginId: 'alice_f', nickname: '앨리스', password: 'Password!23' }).member;
    const bob = auth.signup({ loginId: 'bob_f', nickname: '밥개발', password: 'Password!23' }).member;
    const carol = auth.signup({ loginId: 'carol_f', nickname: '캐롤', password: 'Password!23' }).member;
    const dave = auth.signup({ loginId: 'dave_f', nickname: '데이브', password: 'Password!23' }).member;

    const aliceStartSession = presence.openSession({ memberId: alice.id, channel: 'ssh', spaceId: 'space:focus' });
    const aliceOtherSession = presence.openSession({ memberId: alice.id, channel: 'cli', spaceId: 'space:lobby' });
    const guestSession = presence.openSession({ isGuest: true, channel: 'ssh' });

    // Guest or wrong-member session cannot start focus
    assert.throws(
      () => focus.startFocus(alice.id, guestSession.id),
      (err: unknown) => err instanceof ServiceError && err.code === 'FORBIDDEN',
    );

    // Start focus on aliceStartSession at 23:55:00 KST (2026-11-28)
    const active = focus.startFocus(alice.id, aliceStartSession.id);
    assert.equal(active.startedSessionId, aliceStartSession.id);
    assert.equal(active.endedAt, null);

    // Enforces at most 1 active focus per member even from a different session
    assert.throws(
      () => focus.startFocus(alice.id, aliceOtherSession.id),
      (err: unknown) => err instanceof ServiceError && err.code === 'CONFLICT',
    );

    // Ending a DIFFERENT session of Alice MUST NOT stop focus!
    clock.advanceMinutes(3); // 23:58:00 KST
    presence.heartbeat(aliceStartSession.id);
    presence.closeSession(aliceOtherSession.id, { mode: 'disconnect' });
    const ignored = focus.handleSessionEnded(aliceOtherSession.id, 'disconnect');
    assert.equal(ignored, null);
    assert.ok(focus.getFocusStatus(alice.id).activeSession);

    // Advance clock 12 minutes to 00:10:00 KST (2026-11-29), then disconnect aliceStartSession
    // Last heartbeat was at 23:58:00 KST -> wait: let's heartbeat at 00:05:00 KST, disconnect detected at 00:10:00 KST!
    clock.advanceMinutes(7); // 00:05:00 KST (2026-11-29)
    presence.heartbeat(aliceStartSession.id); // last_heartbeat_at = 2026-11-28T15:05:00.000Z (00:05:00 KST)
    clock.advanceMinutes(5); // 00:10:00 KST (2026-11-29)

    presence.closeSession(aliceStartSession.id, { mode: 'disconnect' });
    const stoppedByDisconnect = focus.handleSessionEnded(aliceStartSession.id, 'disconnect');
    assert.ok(stoppedByDisconnect);
    // Ended at last_heartbeat_at (00:05:00 KST), NOT clock.now() (00:10:00 KST)!
    // Total = 10 minutes = 600s: 300s on 2026-11-28 + 300s on 2026-11-29
    assert.equal(stoppedByDisconnect.endedAt, '2026-11-28T15:05:00.000Z');
    assert.equal(stoppedByDisconnect.countedSeconds, 600);

    // Verify KST midnight split persisted in focus_daily_totals
    const aliceHistory = focus.getFocusHistory(alice.id, alice.id);
    assert.deepEqual(
      aliceHistory.dailyTotals,
      [
        { kstDate: '2026-11-29', totalSeconds: 300 },
        { kstDate: '2026-11-28', totalSeconds: 300 },
      ],
    );

    // Other member and guest are FORBIDDEN from viewing Alice's detailed focus history
    assert.throws(
      () => focus.getFocusHistory(bob.id, alice.id),
      (err: unknown) => err instanceof ServiceError && err.code === 'FORBIDDEN',
    );
    assert.throws(
      () => focus.getFocusHistory(null, alice.id),
      (err: unknown) => err instanceof ServiceError && err.code === 'FORBIDDEN',
    );

    // Ranking ties (1, 1, 3) on 2026-11-29:
    // Alice already has 300s on 2026-11-29.
    // Bob also focuses 300s (normal stop using clock.now() with sub-second floor).
    // Carol focuses 120s.
    // Dave is still active and gets closed by closeAllActiveFocusForShutdown for 60s.
    const bobSession = presence.openSession({ memberId: bob.id, channel: 'ssh' });
    focus.startFocus(bob.id, bobSession.id);
    clock.advanceMs(300_900); // 300.9 seconds -> floored to 300s!
    const bobStopped = focus.stopFocus(bob.id);
    assert.equal(bobStopped.countedSeconds, 300);

    const carolSession = presence.openSession({ memberId: carol.id, channel: 'ssh' });
    focus.startFocus(carol.id, carolSession.id);
    clock.advanceSeconds(120);
    focus.stopFocus(carol.id);

    const daveSession = presence.openSession({ memberId: dave.id, channel: 'ssh' });
    focus.startFocus(dave.id, daveSession.id);
    clock.advanceSeconds(60);
    const shutdownClosed = focus.closeAllActiveFocusForShutdown();
    assert.equal(shutdownClosed.length, 1);
    assert.equal(shutdownClosed[0]?.countedSeconds, 60);

    const ranking = focus.getDailyRanking('2026-11-29');
    assert.deepEqual(ranking, [
      { rank: 1, nickname: '밥개발', totalSeconds: 300 },
      { rank: 1, nickname: '앨리스', totalSeconds: 300 },
      { rank: 3, nickname: '캐롤', totalSeconds: 120 },
      { rank: 4, nickname: '데이브', totalSeconds: 60 },
    ]);

    // Ensure ranking exposes ONLY rank, nickname, totalSeconds
    for (const entry of ranking) {
      assert.deepEqual(Object.keys(entry).sort(), ['nickname', 'rank', 'totalSeconds']);
    }
  } finally {
    worldDb.close();
  }
});

test('RoofTopScreen, FocusScreen, and LivingRoomScreen mount cleanly in Ink and reflect service state', async () => {
  const { worldDb, hub, auth, presence, chat, focus } = setupEnv('2026-11-28T05:00:00.000Z');
  try {
    const member = auth.signup({ loginId: 'tui_user', nickname: '티유아이', password: 'Password!23' }).member;
    const session = presence.openSession({ memberId: member.id, channel: 'ssh', spaceId: 'space:living' });
    chat.sendMessage({ memberId: member.id, body: '화면 렌더 테스트' });
    focus.startFocus(member.id, session.id);

    const mountScreen = async (element: ReturnType<typeof createElement>) => {
      let output = '';
      const stdin = Object.assign(new PassThrough(), {
        isTTY: true,
        setRawMode() { return this; },
        ref() { return this; },
        unref() { return this; },
      });
      const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 90, rows: 24 });
      stdout.on('data', (chunk) => {
        output += String(chunk).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
      });
      const app = render(element, {
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
        exitOnCtrlC: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      app.unmount();
      return output;
    };

    const rooftopText = await mountScreen(
      createElement(RoofTopScreen, {
        chatService: chat,
        hub,
        actor: { memberId: member.id, nickname: member.nickname, role: member.role },
      }),
    );
    assert.match(rooftopText, /RoofTop/);
    assert.match(rooftopText, /화면 렌더 테스트/);

    const focusText = await mountScreen(
      createElement(FocusScreen, {
        focusService: focus,
        hub,
        actor: { memberId: member.id, nickname: member.nickname, isGuest: false, sessionId: session.id },
      }),
    );
    assert.match(focusText, /Focus Room/);
    assert.match(focusText, /집중 중/);

    const livingText = await mountScreen(
      createElement(LivingRoomScreen, {
        presenceService: presence,
        hub,
        actor: { memberId: member.id, nickname: member.nickname, isGuest: false, sessionId: session.id },
      }),
    );
    assert.match(livingText, /Living Room/);
    assert.match(livingText, /자리 비움/);
  } finally {
    worldDb.close();
  }
});
