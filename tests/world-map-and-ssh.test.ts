import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import { render } from 'ink';
import ssh2 from 'ssh2';
import { AuthService } from '../src/core/auth-service.js';
import { FakeClock } from '../src/core/clock.js';
import { ServiceError } from '../src/core/errors.js';
import {
  ARCHIVED_SPACE_LABEL,
  GuestbookService,
  WITHDRAWN_AUTHOR_LABEL,
} from '../src/core/guestbook-service.js';
import { ProfileService } from '../src/core/profile-service.js';
import { startSshServer } from '../src/ssh/ssh-server.js';
import { WorldApp } from '../src/tui/WorldApp.js';
import {
  buildWorldMap,
  computeCameraViewport,
  getAdjacentSpace,
  isBlocked,
  moveAvatar,
  renderWorldMapLines,
} from '../src/tui/world-map.js';
import { WorldDatabase } from '../src/store/sqlite/database.js';
import { createTerminalInput } from '../src/ui/terminal-input.js';

const { Client: SshClient } = ssh2;

function stripAnsi(raw: string): string {
  return raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

function createFakeTerminal(columns = 120, rows = 30) {
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: true,
    setRawMode() {
      return this;
    },
    ref() {
      return this;
    },
    unref() {
      return this;
    },
  });
  let output = '';
  const stdout = Object.assign(new PassThrough(), {
    isTTY: true,
    columns,
    rows,
  });
  stdout.on('data', chunk => {
    output += String(chunk);
  });
  const stderr = new PassThrough();
  stderr.resume();
  return {
    stdin,
    stdout,
    stderr,
    output: () => stripAnsi(output),
    clear: () => {
      output = '';
    },
  };
}

test('2.5D world map handles movement, collision, doors/adjacency, camera panning, and remote avatars', () => {
  const clock = new FakeClock('2026-11-28T03:00:00.000Z');
  const worldDb = new WorldDatabase({ dbPath: ':memory:' });
  try {
    const auth = new AuthService(worldDb, clock);
    const profiles = new ProfileService(worldDb, clock);

    // Create 15 users so personal terminal slots span multiple rows (slots 0..14)
    const users = Array.from({ length: 15 }, (_, idx) =>
      auth.signup({
        loginId: `user_${String(idx).padStart(2, '0')}`,
        nickname: `유저${idx}`,
        password: 'Password!23',
      }),
    );

    const personalSpaces = profiles.listPublicPersonalSpaces();
    assert.equal(personalSpaces.length, 15);

    const map = buildWorldMap(personalSpaces);
    assert.ok(map.spaces.some(s => s.id === 'space:lobby'));
    assert.ok(map.spaces.some(s => s.id === 'space:focus'));
    assert.ok(map.spaces.some(s => s.id === 'space:cafe'));
    assert.ok(map.spaces.some(s => s.id === 'space:rooftop'));
    assert.ok(map.spaces.some(s => s.id === 'space:living'));
    assert.ok(map.spaces.some(s => s.id === 'space:oss'));
    assert.ok(map.spaces.some(s => s.id === users[0]!.personalSpace.id));

    // Boundaries & building interiors are blocked
    assert.equal(isBlocked(map, -1, 0), true);
    assert.equal(isBlocked(map, map.width, 0), true);
    assert.equal(isBlocked(map, 4, 2), true); // inside LOBBY building

    // Spawn is walkable and moving up toward LOBBY door reaches door tile and detects LOBBY
    let pos = { ...map.defaultSpawn };
    assert.equal(isBlocked(map, pos.x, pos.y), false);

    const up1 = moveAvatar(map, pos, 0, -1);
    assert.equal(up1.moved, true);
    pos = { x: up1.x, y: up1.y };

    const up2 = moveAvatar(map, pos, 0, -1); // now on LOBBY door tile (y=5)
    assert.equal(up2.moved, true);
    pos = { x: up2.x, y: up2.y };

    const doorMatch = getAdjacentSpace(map, pos.x, pos.y);
    assert.ok(doorMatch);
    assert.equal(doorMatch.space.id, 'space:lobby');
    assert.equal(doorMatch.onDoor, true);

    // Stepping into building wall from door is blocked
    const intoWall = moveAvatar(map, pos, 0, -1);
    assert.equal(intoWall.moved, false);
    assert.equal(intoWall.blocked, true);

    // Stepping 1 tile left of door is still 1-tile adjacent to LOBBY (onDoor: false)
    const side = moveAvatar(map, pos, -1, 0);
    assert.equal(side.moved, true);
    const sideMatch = getAdjacentSpace(map, side.x, side.y);
    assert.ok(sideMatch);
    assert.equal(sideMatch.space.id, 'space:lobby');
    assert.equal(sideMatch.onDoor, false);

    // Camera viewport panning (1:1 tile scale, no zoom) across X and Y
    let cam = computeCameraViewport(map, { x: 9, y: 7 }, 60, 14);
    assert.equal(cam.width, 60);
    assert.equal(cam.height, 14);
    assert.equal(cam.x, 0);
    assert.equal(cam.y, 0);

    // Move far right to OSS building door (x ~ 109) and down to slot row 2 (y ~ 27)
    const farPos = { x: 109, y: 27 };
    cam = computeCameraViewport(map, farPos, 60, 14, cam);
    assert.ok(cam.x > 0, `expected horizontal camera pan > 0, got ${cam.x}`);
    assert.ok(cam.y > 0, `expected vertical camera pan > 0, got ${cam.y}`);
    assert.equal(cam.width, 60);
    assert.equal(cam.height, 14);

    // Render map with remote online avatar + away indicator
    const rendered = renderWorldMapLines(map, {
      playerX: 10,
      playerY: 7,
      playerNickname: '나',
      remoteAvatars: [
        {
          sessionId: 's-1',
          memberId: users[1]!.member.id,
          nickname: '유저1',
          x: 25,
          y: 7,
          spaceId: 'space:living',
          away: true,
        },
      ],
      camera: { x: 0, y: 0, width: 80, height: 18 },
    });
    const joined = rendered.join('\n');
    assert.match(joined, /★ @나/);
    assert.match(joined, /● @유저1 \[자리비움\]/);
    assert.match(joined, /LOBBY/);
    assert.match(joined, /CAFE/);
  } finally {
    worldDb.close();
  }
});

test('ProfileService supports 4 themes, 40x12 ASCII art, HTTPS URL, non-mutating preview, and update', () => {
  const clock = new FakeClock('2026-11-28T03:00:00.000Z');
  const worldDb = new WorldDatabase({ dbPath: ':memory:' });
  try {
    const auth = new AuthService(worldDb, clock);
    const profiles = new ProfileService(worldDb, clock);
    const { member } = auth.signup({
      loginId: 'dev_mina',
      nickname: 'Mina',
      password: 'Password!23',
    });

    const initialProfile = profiles.getProfile(member.id);
    assert.equal(initialProfile.introduction, '');
    assert.equal(profiles.getPersonalSpace('Mina').colorTheme, 'dark');

    // Preview validates without mutating DB
    const art40x12 = Array.from({ length: 12 }, (_, i) =>
      `${String(i + 1).padStart(2, '0')}:${'='.repeat(37)}`,
    ).join('\n');
    const preview = profiles.previewProfileUpdate(member.id, {
      introduction: '터미널을 좋아하는 개발자입니다.',
      technologyStack: ['TypeScript', 'Node.js', 'SQLite'],
      currentStatus: '코드 리뷰 중',
      projectUrl: 'https://github.com/example/terminal-world',
      asciiArt: art40x12,
      colorTheme: 'amber',
    });
    assert.equal(preview.previewOnly, true);
    assert.equal(preview.personalSpace.colorTheme, 'amber');
    assert.ok(preview.changedFields.includes('colorTheme'));

    // DB must remain unchanged after preview!
    assert.equal(profiles.getPersonalSpace(member.id).colorTheme, 'dark');
    assert.equal(profiles.getProfile(member.id).introduction, '');

    // Reject invalid URL (http://), oversized ASCII (>40 cols or >12 lines), and invalid theme
    assert.throws(
      () => profiles.previewProfileUpdate(member.id, { projectUrl: 'http://insecure.example.com' }),
      (err: unknown) => err instanceof ServiceError && err.code === 'INVALID_INPUT' && err.field === 'projectUrl',
    );
    assert.throws(
      () => profiles.updateProfile(member.id, { asciiArt: 'x'.repeat(41) }),
      (err: unknown) => err instanceof ServiceError && err.code === 'INVALID_INPUT' && err.field === 'asciiArt',
    );
    assert.throws(
      () => profiles.updateProfile(member.id, { asciiArt: Array(13).fill('hi').join('\n') }),
      (err: unknown) => err instanceof ServiceError && err.code === 'INVALID_INPUT' && err.field === 'asciiArt',
    );
    assert.throws(
      () => profiles.updateProfile(member.id, { colorTheme: 'neon' }),
      (err: unknown) => err instanceof ServiceError && err.code === 'INVALID_INPUT' && err.field === 'theme',
    );

    // Update across all 4 valid themes
    for (const theme of ['dark', 'light', 'green', 'amber'] as const) {
      const updated = profiles.updateProfile(member.id, {
        introduction: '안녕하세요',
        technologyStack: ['TypeScript', 'Ink'],
        currentStatus: `${theme} 테마 적용`,
        projectUrl: 'https://example.com/project',
        asciiArt: ' /\\_/\\\n( o.o )',
        colorTheme: theme,
      });
      assert.equal(updated.personalSpace.colorTheme, theme);
      assert.equal(profiles.getPersonalSpace(member.id).colorTheme, theme);
    }

    const list = profiles.listPublicPersonalSpaces();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.nickname, 'Mina');
    assert.equal(list[0]!.colorTheme, 'amber');
  } finally {
    worldDb.close();
  }
});

test('GuestbookService enforces permissions, archived space read-only create block, and admin tombstone', () => {
  const clock = new FakeClock('2026-11-28T03:00:00.000Z');
  const worldDb = new WorldDatabase({ dbPath: ':memory:' });
  try {
    const auth = new AuthService(worldDb, clock);
    const guestbook = new GuestbookService(worldDb, clock);

    const owner = auth.signup({ loginId: 'owner_1', nickname: '주인장', password: 'Password!23' });
    const author = auth.signup({ loginId: 'author_1', nickname: '방문자', password: 'Password!23' });
    const other = auth.signup({ loginId: 'other_1', nickname: '제삼자', password: 'Password!23' });
    const adminSignup = auth.signup({ loginId: 'admin_1', nickname: '운영자', password: 'Password!23' });
    const admin = auth.setMemberRole(adminSignup.member.id, 'admin');

    const entry1 = guestbook.createEntry(author.member.id, owner.personalSpace.id, '첫 방명록입니다!');
    const entry2 = guestbook.createEntry(author.member.id, '주인장', '두 번째 방명록입니다!');
    assert.equal(guestbook.listEntries(owner.personalSpace.id).length, 2);

    // Non-author cannot update or delete
    assert.throws(
      () => guestbook.updateEntry(other.member.id, entry1.id, '변조 시도'),
      (err: unknown) => err instanceof ServiceError && err.code === 'FORBIDDEN',
    );
    assert.throws(
      () => guestbook.deleteEntry(other.member.id, entry1.id),
      (err: unknown) => err instanceof ServiceError && err.code === 'FORBIDDEN',
    );

    // Reject writing to nonexistent or archived space
    assert.throws(
      () => guestbook.createEntry(author.member.id, 'space:member:does-not-exist', 'hello'),
      (err: unknown) => err instanceof ServiceError && err.code === 'NOT_FOUND',
    );
    assert.throws(
      () => guestbook.createEntry(author.member.id, 'archived', 'hello'),
      (err: unknown) => err instanceof ServiceError && err.code === 'FORBIDDEN',
    );

    // Simulate owner withdrawal -> personal_spaces deleted -> target_space_id becomes NULL
    worldDb.db.prepare("UPDATE members SET state = 'withdrawn' WHERE id = ?").run(owner.member.id);
    worldDb.db.prepare('DELETE FROM personal_spaces WHERE member_id = ?').run(owner.member.id);

    // Archived entries show '탈퇴한 사용자의 공간' and block new writes
    const archived = guestbook.listArchivedEntries();
    assert.equal(archived.length, 2);
    assert.equal(archived[0]!.targetSpaceLabel, ARCHIVED_SPACE_LABEL);
    assert.equal(archived[0]!.isArchivedSpace, true);

    assert.throws(
      () => guestbook.createEntry(author.member.id, owner.personalSpace.id, '탈퇴 공간에 작성 시도'),
      (err: unknown) => err instanceof ServiceError && (err.code === 'NOT_FOUND' || err.code === 'FORBIDDEN'),
    );

    // Author CAN update own entry even in archived space!
    const updatedInArchive = guestbook.updateEntry(author.member.id, entry1.id, '보관 공간에서 수정함');
    assert.equal(updatedInArchive.body, '보관 공간에서 수정함');
    assert.equal(updatedInArchive.targetSpaceLabel, ARCHIVED_SPACE_LABEL);

    // Author can soft-delete own entry (no moderation tombstone)
    const authorDel = guestbook.deleteEntry(author.member.id, entry1.id);
    assert.equal(authorDel.byAdmin, false);
    assert.equal(guestbook.listArchivedEntries().length, 1);

    // Active admin can delete another member's entry and records tombstone + moderation_deletions
    const adminDel = guestbook.deleteEntry(admin.id, entry2.id, '스팸 정리');
    assert.equal(adminDel.byAdmin, true);
    assert.equal(guestbook.listArchivedEntries().length, 0);

    const tombstones = worldDb.readTombstoneLog();
    assert.equal(tombstones.length, 1);
    assert.equal(tombstones[0]!.kind, 'delete_content');
    assert.equal(tombstones[0]!.targetKind, 'guestbook');
    assert.equal(tombstones[0]!.targetId, entry2.id);

    // Author withdrawal displays WITHDRAWN_AUTHOR_LABEL
    const entry3 = guestbook.createEntry(other.member.id, admin.id, '작성자 탈퇴 테스트');
    worldDb.db.prepare("UPDATE members SET state = 'withdrawn' WHERE id = ?").run(other.member.id);
    worldDb.db.prepare('UPDATE guestbook_entries SET author_member_id = NULL WHERE id = ?').run(entry3.id);
    const listed = guestbook.listEntries(admin.id);
    assert.equal(listed[0]!.authorNickname, WITHDRAWN_AUTHOR_LABEL);
  } finally {
    worldDb.close();
  }
});

test('WorldApp switches between 120x30 2.5D map and 80x24 list fallback, and preserves state across <80x24 overlay', async () => {
  const clock = new FakeClock('2026-11-28T03:00:00.000Z');
  const worldDb = new WorldDatabase({ dbPath: ':memory:' });
  const term = createFakeTerminal(120, 30);
  const input = createTerminalInput(term.stdin, {
    mouse: false,
    onEnd: () => {},
    onError: () => {},
  });

  const auth = new AuthService(worldDb, clock);
  const profiles = new ProfileService(worldDb, clock);
  const guestbook = new GuestbookService(worldDb, clock);
  const { member } = auth.signup({
    loginId: 'tui_user',
    nickname: '티유아이',
    password: 'Password!23',
  });

  const instance = render(
    createElement(WorldApp, {
      authService: auth,
      profileService: profiles,
      guestbookService: guestbook,
      initialViewer: {
        isGuest: false,
        memberId: member.id,
        nickname: member.nickname,
        role: member.role,
      },
    }),
    {
      stdin: input.stdin as unknown as NodeJS.ReadStream,
      stdout: term.stdout as unknown as NodeJS.WriteStream,
      stderr: term.stderr as unknown as NodeJS.WriteStream,
      interactive: true,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );

  try {
    await instance.waitUntilRenderFlush();
    await delay(40);
    // 120x30 defaults to 2.5D map
    assert.match(term.output(), /2\.5D MAP/);
    assert.match(term.output(), /LOBBY/);

    // Press 'm' -> toggles to list exploration
    term.clear();
    term.stdin.write('m');
    await delay(40);
    await instance.waitUntilRenderFlush();
    assert.match(term.output(), /목록 탐색/);

    // Press 'm' -> toggles back to 2.5D map
    term.clear();
    term.stdin.write('m');
    await delay(40);
    await instance.waitUntilRenderFlush();
    assert.match(term.output(), /2\.5D MAP/);

    // Shrink to 80x24 -> auto-falls back to list mode
    term.clear();
    term.stdout.columns = 80;
    term.stdout.rows = 24;
    term.stdout.emit('resize');
    await delay(50);
    await instance.waitUntilRenderFlush();
    assert.match(term.output(), /목록 탐색/);

    // Shrink below 80x24 -> resize overlay without losing viewer session
    term.clear();
    term.stdout.columns = 60;
    term.stdout.rows = 18;
    term.stdout.emit('resize');
    await delay(50);
    await instance.waitUntilRenderFlush();
    assert.match(term.output(), /80×24 이상/);

    // Grow back to 120x30 -> restores 2.5D map and viewer '@티유아이'
    term.clear();
    term.stdout.columns = 120;
    term.stdout.rows = 30;
    term.stdout.emit('resize');
    await delay(50);
    await instance.waitUntilRenderFlush();
    assert.match(term.output(), /2\.5D MAP/);
    assert.match(term.output(), /@티유아이/);
  } finally {
    instance.unmount();
    await instance.waitUntilExit();
    input.dispose();
    term.stdin.destroy();
    term.stdout.destroy();
    term.stderr.destroy();
    worldDb.close();
  }
});

test('ssh2 server generates/reuses 0600 ed25519 host key, serves PTY Ink UI with window-change resize, and isolates errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-ssh-test-'));
  const clock = new FakeClock('2026-11-28T03:00:00.000Z');
  const worldDb = new WorldDatabase({ dataDir: dir });
  const auth = new AuthService(worldDb, clock);
  const profiles = new ProfileService(worldDb, clock);
  const guestbook = new GuestbookService(worldDb, clock);

  const server1 = await startSshServer({
    dataDir: dir,
    host: '127.0.0.1',
    port: 0,
    authService: auth,
    profileService: profiles,
    guestbookService: guestbook,
  });

  try {
    const keyStat = statSync(server1.hostKeyPath);
    assert.equal(keyStat.mode & 0o777, 0o600);
    const firstKeyBytes = readFileSync(server1.hostKeyPath, 'utf8');

    // Connect real ssh2 Client with 120x30 PTY and resize via window-change to 80x24
    const client = new SshClient();
    let captured = '';

    await new Promise<void>((resolve, reject) => {
      client.on('error', reject);
      client.on('ready', () => {
        client.shell({ cols: 120, rows: 30, term: 'xterm-256color' }, (err, stream) => {
          if (err) {
            reject(err);
            return;
          }
          stream.on('data', (chunk: Buffer) => {
            captured += stripAnsi(chunk.toString('utf8'));
          });

          (async () => {
            await delay(150);
            assert.match(captured, /TERMINAL WORLD/);
            assert.match(captured, /접속 게이트/);

            // Enter as guest (Enter key on default guest tab)
            captured = '';
            stream.write('\r');
            await delay(150);
            assert.match(captured, /2\.5D MAP/);

            // Trigger SSH window-change resize to 80x24 -> auto list fallback!
            captured = '';
            stream.setWindow(24, 80, 0, 0);
            await delay(180);
            assert.match(captured, /목록 탐색/);

            stream.end();
            client.end();
            resolve();
          })().catch(reject);
        });
      });

      client.connect({
        host: '127.0.0.1',
        port: server1.port,
        username: 'guest',
      });
    });

    await server1.close();

    // Restart server on same dataDir -> must reuse identical host key
    let throwFirstSession = true;
    const errors: unknown[] = [];
    const server2 = await startSshServer({
      dataDir: dir,
      host: '127.0.0.1',
      port: 0,
      authService: auth,
      profileService: profiles,
      guestbookService: guestbook,
      onSessionError: (_sid, err) => errors.push(err),
      renderSession: ctx => {
        if (throwFirstSession) {
          throwFirstSession = false;
          function CrashComponent(): never {
            throw new Error('simulated-session-crash');
          }
          return createElement(CrashComponent);
        }
        return createElement(WorldApp, {
          authService: auth,
          profileService: profiles,
          guestbookService: guestbook,
          onExit: ctx.onExit,
        });
      },
    });

    try {
      const reusedKeyBytes = readFileSync(server2.hostKeyPath, 'utf8');
      assert.equal(reusedKeyBytes, firstKeyBytes);
      assert.equal(statSync(server2.hostKeyPath).mode & 0o777, 0o600);

      // Session 1 crashes inside React ErrorBoundary
      const c1 = new SshClient();
      let c1Out = '';
      await new Promise<void>((resolve, reject) => {
        c1.on('error', reject);
        c1.on('ready', () => {
          c1.shell({ cols: 100, rows: 30, term: 'xterm-256color' }, (err, stream) => {
            if (err) { reject(err); return; }
            stream.on('data', (d: Buffer) => { c1Out += stripAnsi(d.toString('utf8')); });
            setTimeout(() => {
              stream.end();
              c1.end();
              resolve();
            }, 150);
          });
        });
        c1.connect({ host: '127.0.0.1', port: server2.port, username: 'crash' });
      });
      assert.match(c1Out, /simulated-session-crash/);
      assert.ok(errors.length >= 1);

      // Session 2 connects cleanly after Session 1 crashed!
      const c2 = new SshClient();
      let c2Out = '';
      await new Promise<void>((resolve, reject) => {
        c2.on('error', reject);
        c2.on('ready', () => {
          c2.shell({ cols: 120, rows: 30, term: 'xterm-256color' }, (err, stream) => {
            if (err) { reject(err); return; }
            stream.on('data', (d: Buffer) => { c2Out += stripAnsi(d.toString('utf8')); });
            setTimeout(() => {
              stream.end();
              c2.end();
              resolve();
            }, 150);
          });
        });
        c2.connect({ host: '127.0.0.1', port: server2.port, username: 'healthy' });
      });
      assert.match(c2Out, /TERMINAL WORLD/);
    } finally {
      await server2.close();
    }
  } finally {
    worldDb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
