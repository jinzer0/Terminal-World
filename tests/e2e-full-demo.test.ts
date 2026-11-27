import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client as SshClient } from 'ssh2';
import { runCli } from '../src/cli-cmd/router.js';
import { FakeClock } from '../src/core/clock.js';
import { createTerminalWorldMcpServer } from '../src/mcp/tools.js';
import { startWorldServer } from '../src/server.js';

function createMemoryWriter() {
  let buf = '';
  return {
    stream: {
      write(chunk: string) {
        buf += chunk;
        return true;
      },
      isTTY: false,
    },
    read: () => buf,
  };
}

async function runCliJson(
  argv: string[],
  credentialsPath: string,
): Promise<{ exitCode: number; json: Record<string, unknown>; stderr: string }> {
  const out = createMemoryWriter();
  const err = createMemoryWriter();
  const exitCode = await runCli([...argv, '--json'], {
    stdout: out.stream,
    stderr: err.stream,
    credentialsPath,
  });
  const text = out.read().trim();
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  return { exitCode, json, stderr: err.read() };
}

test('E2E full demo: single WorldServer exercises UC-01~UC-18 across SSH PTY, CLI, and MCP', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-e2e-full-'));
  const clock = new FakeClock('2026-11-28T01:00:00.000Z');
  const server = await startWorldServer({
    dataDir: dir,
    clock,
    sshHost: '127.0.0.1',
    sshPort: 0,
    bridgeHost: '127.0.0.1',
    bridgePort: 0,
    enableMcpHttp: false,
  });

  try {
    assert.ok(server.ssh && server.ssh.port > 0, 'SSH server listening');
    assert.ok(server.bridge && server.bridge.baseUrl, 'HTTP Bridge listening');

    // Verify 0600 ed25519 host key generated in dataDir
    const hostKeyPath = join(dir, 'ssh_host_ed25519.key');
    assert.equal(existsSync(hostKeyPath), true);
    assert.equal(statSync(hostKeyPath).mode & 0o777, 0o600);

    // 1. UC-01 & UC-02: Atomic signup for Member A, Member B, and Admin
    const signupA = server.authService.signup({
      loginId: 'alice_dev',
      nickname: '앨리스',
      password: 'Password!23',
    });
    const signupB = server.authService.signup({
      loginId: 'bob_dev',
      nickname: '밥개발',
      password: 'Password!23',
    });
    const signupAdmin = server.authService.signup({
      loginId: 'admin_root',
      nickname: '운영자',
      password: 'Password!23',
    });
    server.authService.setMemberRole(signupAdmin.member.id, 'admin');

    // 2. UC-15: CLI 6-char approval code -> approve -> exchange -> use CLI for community & profile
    const credA = join(dir, 'cred-alice.json');
    const credAdmin = join(dir, 'cred-admin.json');

    const startA = server.integrationAuthService.startApproval({
      channel: 'cli',
      scopes: ['read', 'write'],
      clientLabel: 'cli-alice',
    });
    server.integrationAuthService.approveCode({
      code: startA.code,
      loginId: 'alice_dev',
      password: 'Password!23',
    });
    const exchangedA = server.integrationAuthService.exchangeApprovalCode(startA.code);
    assert.ok(exchangedA.accessToken && exchangedA.refreshToken);

    // Write credentials via CLI login-free exchange or bridge helper? Test CLI with saved credentials file
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      credA,
      JSON.stringify({
        serverUrl: server.bridge.baseUrl,
        grantId: exchangedA.grant.id,
        accessToken: exchangedA.accessToken,
        refreshToken: exchangedA.refreshToken,
        accessExpiresAt: exchangedA.accessTokenExpiresAt,
        refreshExpiresAt: exchangedA.refreshTokenExpiresAt,
        grantExpiresAt: exchangedA.grant.expiresAt,
        scopes: exchangedA.grant.scopes,
      }),
      { mode: 0o600 },
    );

    const startAdm = server.integrationAuthService.startApproval({
      channel: 'cli',
      scopes: ['read', 'write', 'admin'],
      clientLabel: 'cli-admin',
    });
    server.integrationAuthService.approveCode({
      code: startAdm.code,
      loginId: 'admin_root',
      password: 'Password!23',
    });
    const exchangedAdm = server.integrationAuthService.exchangeApprovalCode(startAdm.code);
    writeFileSync(
      credAdmin,
      JSON.stringify({
        serverUrl: server.bridge.baseUrl,
        grantId: exchangedAdm.grant.id,
        accessToken: exchangedAdm.accessToken,
        refreshToken: exchangedAdm.refreshToken,
        accessExpiresAt: exchangedAdm.accessTokenExpiresAt,
        refreshExpiresAt: exchangedAdm.refreshTokenExpiresAt,
        grantExpiresAt: exchangedAdm.grant.expiresAt,
        scopes: exchangedAdm.grant.scopes,
      }),
      { mode: 0o600 },
    );

    // CLI guest read (UC-01 / UC-03): world spaces & boards
    const spacesRes = await runCliJson(['--server', server.bridge.baseUrl, 'world', 'spaces'], join(dir, 'guest.json'));
    assert.equal(spacesRes.exitCode, 0);
    assert.equal(spacesRes.json.ok, true);

    // CLI UC-04: Profile edit + 4-theme + HTTPS URL
    const profEdit = await runCliJson(
      [
        '--server',
        server.bridge.baseUrl,
        'profile',
        'edit',
        '--intro',
        '터미널 월드 개발자',
        '--status',
        '코딩 중',
        '--theme',
        'green',
        '--url',
        'https://github.com/example/terminal-world',
      ],
      credA,
    );
    assert.equal(profEdit.exitCode, 0);

    // CLI UC-05: Guestbook on Bob's space
    const gbCreate = await runCliJson(
      ['--server', server.bridge.baseUrl, 'guestbook', 'create', '밥개발', '--body', '반가워요 밥님!'],
      credA,
    );
    assert.equal(gbCreate.exitCode, 0);

    // CLI UC-06: Cafe board post + comment
    const postCreate = await runCliJson(
      [
        '--server',
        server.bridge.baseUrl,
        'board',
        'post',
        'create',
        'free',
        '--title',
        '첫 인사',
        '--body',
        '모두 반갑습니다!',
      ],
      credA,
    );
    assert.equal(postCreate.exitCode, 0);
    const createdPostId = (postCreate.json.data as { id: string }).id;
    assert.ok(createdPostId);

    // CLI UC-18: Recruitment create + bookmark
    const recCreate = await runCliJson(
      [
        '--server',
        server.bridge.baseUrl,
        'recruit',
        'create',
        '--title',
        '해커톤 팀원 모집',
        '--body',
        '함께 만들어요',
        '--type',
        'hackathon',
        '--progress',
        '아이디어 확정',
        '--roles',
        'Backend,TUI',
        '--skills',
        'TypeScript',
        '--period',
        '2주',
        '--weekly-time',
        '10시간',
        '--mode',
        'online',
        '--contact',
        'https://github.com/example/team',
        '--deadline',
        '2026-12-05',
        '--ack-public',
      ],
      credA,
    );
    assert.equal(recCreate.exitCode, 0);
    const recPostId = (recCreate.json.data as { id: string }).id;
    assert.ok(recPostId);
    const bmAdd = await runCliJson(
      ['--server', server.bridge.baseUrl, 'recruit', 'bookmark', 'add', recPostId],
      credA,
    );
    assert.equal(bmAdd.exitCode, 0);

    // CLI UC-08: Admin creates notice
    const noticeRes = await runCliJson(
      [
        '--server',
        server.bridge.baseUrl,
        'notice',
        'create',
        '--title',
        '오픈 안내',
        '--body',
        'Terminal-World 데모가 열렸습니다.',
      ],
      credAdmin,
    );
    assert.equal(noticeRes.exitCode, 0);

    // 3. UC-07, UC-09, UC-10: Presence (Living Room), RoofTop Chat, Focus Room
    const sessA = server.presenceService.openSession({ memberId: signupA.member.id, channel: 'ssh' });
    server.presenceService.moveSpace(sessA.id, 'space:living');
    assert.equal(server.presenceService.getMemberPresence(signupA.member.id).status, 'away');
    server.presenceService.moveSpace(sessA.id, 'space:focus');
    assert.equal(server.presenceService.getMemberPresence(signupA.member.id).status, 'online');

    server.focusService.startFocus(signupA.member.id, sessA.id);
    clock.advanceMinutes(15);
    const stopped = server.focusService.stopFocus(signupA.member.id);
    assert.equal(stopped.countedSeconds, 900);
    assert.equal(server.focusService.getDailyRanking().length, 1);

    const chatMsg = server.chatService.sendMessage({
      memberId: signupA.member.id,
      body: '안녕하세요 RoofTop!',
      idempotencyKey: 'idem-chat-1',
    });
    const chatDup = server.chatService.sendMessage({
      memberId: signupA.member.id,
      body: '안녕하세요 RoofTop!',
      idempotencyKey: 'idem-chat-1',
    });
    assert.equal(chatMsg.id, chatDup.id);

    // 4. UC-13 & UC-14: Report & Admin Review + Deletion History
    const report = server.moderationService.createReport({
      reporterMemberId: signupB.member.id,
      targetKind: 'post',
      targetId: createdPostId,
      reason: '스팸 테스트 신고',
    });
    const reviewed = server.moderationService.reviewReport({
      adminMemberId: signupAdmin.member.id,
      reportId: report.id,
      outcome: 'deleted',
      resolutionReason: '운영 정책 위반 삭제',
    });
    assert.equal(reviewed.report.reviewState, 'reviewed');
    assert.ok(reviewed.deletion);
    assert.equal(server.moderationService.listDeletionHistory(signupAdmin.member.id).length, 1);

    // 5. UC-16 & UC-17: Official MCP Client via InMemoryTransport (OSS + Demo AI + untrustedContent)
    const mcpServer = createTerminalWorldMcpServer({
      services: server.services,
      serverUrl: server.bridge.baseUrl,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    const mcpClient = new McpClient({ name: 'e2e-client', version: '1.0.0' });
    await mcpClient.connect(clientTransport);

    const toolsList = await mcpClient.listTools();
    assert.ok(toolsList.tools.some(t => t.name === 'oss_search_issues'));
    assert.ok(toolsList.tools.some(t => t.name === 'oss_explain_issue_demo'));

    const ossIssues = await mcpClient.callTool({ name: 'oss_search_issues', arguments: { limit: 5 } });
    assert.equal(ossIssues.isError, undefined);
    const ossPayload = JSON.parse((ossIssues.content as Array<{ text: string }>)[0]!.text) as {
      ok: boolean;
      data: { untrustedContent: boolean; content: { items: Array<{ id: string }> } };
    };
    assert.equal(ossPayload.ok, true);
    assert.equal(ossPayload.data.untrustedContent, true);
    assert.ok(ossPayload.data.content.items.length > 0);

    const explainRes = await mcpClient.callTool({
      name: 'oss_explain_issue_demo',
      arguments: { issueId: ossPayload.data.content.items[0]!.id },
    });
    const explainPayload = JSON.parse((explainRes.content as Array<{ text: string }>)[0]!.text) as {
      ok: boolean;
      data: { untrustedContent: boolean; content: { explanation: { mode: string } } };
    };
    assert.equal(explainPayload.ok, true);
    assert.equal(explainPayload.data.untrustedContent, true);
    assert.equal(explainPayload.data.content.explanation.mode, 'demo');

    await mcpClient.close();
    await mcpServer.close();

    // 6. UC-11 & UC-12 & Backup/Restore Tombstone replay
    const backup = server.retentionService.createDailyBackup(join(dir, 'backups'));
    assert.equal(existsSync(backup.backupPath), true);

    server.accountLifecycleService.withdrawAccount({
      memberId: signupB.member.id,
      password: 'Password!23',
      confirm: true,
    });
    // Bob's guestbook is now archived ('탈퇴한 사용자의 공간')
    const archivedGb = server.guestbookService.listArchivedEntries();
    assert.equal(archivedGb.length, 1);

    // Restore backup into a fresh directory and verify tombstone replay re-withdraws Bob & keeps deleted post deleted
    const restoreDir = join(dir, 'restored');
    const restored = server.retentionService.restoreFromBackup(backup.backupPath, restoreDir, {
      tombstoneLogPath: join(dir, 'tombstones.log'),
    });
    assert.equal(restored.ready, true);
    assert.ok(restored.replayedTombstones >= 2);

    // 7. Real SSH PTY socket connect to WorldServer
    const sshOutput = await new Promise<string>((resolve, reject) => {
      const client = new SshClient();
      let buf = '';
      const timer = setTimeout(() => {
        client.end();
        resolve(buf);
      }, 1200);
      client.on('ready', () => {
        client.shell({ rows: 30, cols: 120, term: 'xterm-256color' }, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            reject(err);
            return;
          }
          stream.on('data', (chunk: Buffer) => {
            buf += chunk.toString('utf8');
            if (buf.includes('TERMINAL WORLD') || buf.length > 60) {
              clearTimeout(timer);
              stream.close();
              client.end();
              resolve(buf);
            }
          });
        });
      });
      client.on('error', err => {
        clearTimeout(timer);
        reject(err);
      });
      client.connect({
        host: '127.0.0.1',
        port: server.ssh!.port,
        username: 'guest',
        tryKeyboard: false,
      });
    });
    assert.ok(sshOutput.length > 0, 'SSH PTY rendered TUI frame');
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Review regressions: non-admin grant cannot admin-delete, author guestbook delete writes tombstone, and SSH WorldApp opens/closes presence session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-e2e-reg-'));
  const clock = new FakeClock('2026-11-28T03:00:00.000Z');
  const server = await startWorldServer({
    dataDir: dir,
    clock,
    enableSsh: false,
    bridgeHost: '127.0.0.1',
    bridgePort: 0,
    enableMcpHttp: false,
  });

  try {
    const alice = server.authService.signup({
      loginId: 'reg_alice',
      nickname: '회귀앨리스',
      password: 'Password!23',
    });
    const admin = server.authService.signup({
      loginId: 'reg_admin',
      nickname: '회귀관리자',
      password: 'Password!23',
    });
    server.authService.setMemberRole(admin.member.id, 'admin');

    // 1. Admin creates a non-admin ['read', 'write'] grant (30-day)
    const approval = server.integrationAuthService.startApproval({
      channel: 'cli',
      scopes: ['read', 'write'],
      clientLabel: 'admin-write-only',
    });
    server.integrationAuthService.approveCode({
      code: approval.code,
      loginId: 'reg_admin',
      password: 'Password!23',
    });
    const tokens = server.integrationAuthService.exchangeApprovalCode(approval.code);

    const post = server.boardService.createPost(alice.member.id, {
      boardId: 'free',
      title: '앨리스 글',
      body: '본문',
    });
    const gb = server.guestbookService.createEntry(alice.member.id, admin.personalSpace.id, '방명록');

    // Non-admin grant MUST NOT delete Alice's post or guestbook via HTTP Bridge
    const delPostRes = await fetch(`${server.bridge!.baseUrl}/posts/${post.id}`, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(delPostRes.status, 403);

    const delGbRes = await fetch(`${server.bridge!.baseUrl}/guestbook/entries/${gb.id}`, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(delGbRes.status, 403);

    // 2. Author deletes own guestbook entry -> tombstone recorded -> backup restore keeps it deleted
    const backup = server.retentionService.createDailyBackup(join(dir, 'backups'));
    server.guestbookService.deleteEntry(alice.member.id, gb.id);
    const tombstones = server.worldDb.readTombstoneLog();
    assert.ok(tombstones.some(t => t.kind === 'delete_content' && t.targetKind === 'guestbook' && t.targetId === gb.id));

    const restoreDir = join(dir, 'restored');
    const restored = server.retentionService.restoreFromBackup(backup.backupPath, restoreDir, {
      tombstoneLogPath: join(dir, 'tombstones.log'),
    });
    assert.equal(restored.ready, true);
    const { WorldDatabase } = await import('../src/store/sqlite/database.js');
    const restoredDb = new WorldDatabase({ dataDir: restoreDir });
    try {
      const row = restoredDb.db.prepare('SELECT deleted_at FROM guestbook_entries WHERE id = ?').get(gb.id) as {
        deleted_at: string | null;
      };
      assert.ok(row.deleted_at, 'author-deleted guestbook entry must stay deleted after restore');
    } finally {
      restoredDb.close();
    }

    // 3. WorldApp mounted with presenceService opens an SSH session and closes it on unmount
    const { render } = await import('ink');
    const { PassThrough } = await import('node:stream');
    const { createElement } = await import('react');
    const { WorldApp } = await import('../src/tui/WorldApp.js');
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    Object.assign(stdin, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    Object.assign(stdout, { isTTY: true, columns: 120, rows: 30 });
    stdout.resume();

    let openedSid: string | null = null;
    const inst = render(
      createElement(WorldApp, {
        authService: server.authService,
        profileService: server.profileService,
        guestbookService: server.guestbookService,
        presenceService: server.presenceService,
        focusService: server.focusService,
        realtimeHub: server.realtimeHub,
        initialViewer: {
          isGuest: false,
          memberId: alice.member.id,
          nickname: alice.member.nickname,
          role: 'member',
        },
        onSessionOpened: sid => {
          if (sid) openedSid = sid;
        },
      }),
      { stdin, stdout, stderr: stdout, patchConsole: false, exitOnCtrlC: false },
    );

    await new Promise(resolve => setTimeout(resolve, 40));
    assert.ok(openedSid, 'WorldApp opened persistent SSH session');
    assert.equal(server.presenceService.getMemberPresence(alice.member.id).status, 'online');

    inst.unmount();
    await inst.waitUntilExit();
    assert.equal(server.presenceService.getMemberPresence(alice.member.id).status, 'offline');
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
