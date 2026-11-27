import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, stat, realpath, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.stderr) process.stderr.write(result.stderr);
  assert.equal(result.error, undefined, `${executable}: ${result.error?.message}`);
  assert.equal(result.status, 0, `${executable} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

const ttyScenario = String.raw`
import os, pty, select, time, struct, fcntl, termios, signal, json, re, sys
config=json.loads(os.environ['TW_CONSUMER_SCENARIO'])
statepath=os.path.join(os.environ['HOME'],'Library','Application Support','Terminal World','state.json')
ansi=re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
def session(restored):
    pid,fd=pty.fork()
    if pid==0:
        os.environ['TERM']='xterm-256color'
        os.chdir(config.get('restartCwd',config['cwd']) if restored else config['cwd'])
        args=config.get('restartCommand',config['command']) if restored else config['command']
        os.execvpe(args[0],args,os.environ)
    fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',30,100,0,0))
    output=bytearray()
    status=None
    def pump(seconds=.1):
        until=time.monotonic()+seconds
        while time.monotonic()<until:
            ready,_,_=select.select([fd],[],[],max(0,until-time.monotonic()))
            if ready:
                try: output.extend(os.read(fd,65536))
                except OSError: break
    def plain(): return ansi.sub('',output.decode('utf8','replace'))
    def frame(): return plain().rsplit('TERMINAL WORLD',1)[-1]
    def send(text): os.write(fd,text.encode()); pump(.15)
    def readstate():
        with open(statepath,encoding='utf8') as file: return json.load(file)
    def navigate(index): send('\t'+'\x1b[A'*5+'\x1b[B'*index+'\r\t')
    def wait_for(predicate,label,timeout=90):
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            pump()
            if predicate(): return
            ended,exitstatus=os.waitpid(pid,os.WNOHANG)
            if ended: raise AssertionError(label+'; child exited '+str(os.waitstatus_to_exitcode(exitstatus))+'\n'+plain()[-4000:])
        raise AssertionError(label+' timed out\n'+plain()[-4000:])
    try:
        if restored:
            wait_for(lambda:config['nickname'] in plain(),'restored nickname')
            with open(statepath,encoding='utf8') as file: state=json.load(file)
            assert state['profile']['nickname']==config['nickname']
            assert state['revision']==(6 if config.get('fullStory') else 1)
            assert '처음 입장' not in frame(),'persisted profile unexpectedly asked to onboard'
        else:
            wait_for(lambda:'닉네임' in plain(),'onboarding')
            os.write(fd,(config['nickname']+'\r').encode())
            def committed():
                if not os.path.isfile(statepath): return False
                try:
                    with open(statepath,encoding='utf8') as file: state=json.load(file)
                    return state['profile']['nickname']==config['nickname'] and '로컬 저장 완료' in plain()
                except (ValueError,KeyError): return False
            wait_for(committed,'first profile durable commit')
        if config.get('fullStory'):
            if not restored:
                send('\r')
                send('소개검증\t상태검증\t\x1b[B\t\x1b[B\x13')
                wait_for(lambda:readstate()['revision']==2,'profile customization commit')
                state=readstate()
                assert state['profile']['introduction'].endswith('소개검증')
                assert state['profile']['status'].endswith('상태검증')
                assert state['profile']['asciiPresetId']=='ascii:mountain'
                assert state['profile']['themeId']=='theme:violet'
                for index,name in enumerate(['Mina','Jun','Sol']):
                    navigate(index+3);send('\r');send(name+'에게만\r')
                    wait_for(lambda:readstate()['revision']==index+3,name+' guestbook commit')
                navigate(1);send('\r');send('한글 채팅👩‍💻')
                for cycle in range(5):
                    for columns,rows in [(80,24),(70,20),(100,30)]:
                        fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',rows,columns,0,0));pump(.15)
                        if columns<80: send('입력되면안됨\r')
                for event in range(20):
                    send('\x1b[<0;5;5M\x1b[<0;5;5m\x1b[<65;40;10M')
                assert '한글 채팅👩‍💻' in frame(),'resize/click/wheel lost the draft'
                assert '먼저 저장/전송하거나 Esc로 취소하세요' in frame(),'dirty route clicks did not guard navigation'
                assert readstate()['revision']==5,'mouse/undersize input sent an unintended mutation'
                send('\r')
                wait_for(lambda:readstate()['revision']==6,'local chat commit')
            state=readstate()
            assert len(state['chatMessages'])==1
            assert state['chatMessages'][0]['text']=='한글 채팅👩‍💻'
            assert len(state['guestbookEntries'])==3
            if restored:
                navigate(1)
                assert '한글 채팅👩‍💻' in frame()
                for index,name in enumerate(['Mina','Jun','Sol']):
                    navigate(index+3)
                    assert name+'에게만' in frame()
                    for other in ['Mina','Jun','Sol']:
                        if other!=name: assert other+'에게만' not in frame(),'cross-target guestbook leak'
                navigate(2)
                assert '상태검증' in frame()
                assert readstate()==state,'read-only restart/navigation changed persisted data'
        os.write(fd,b'\x03')
        deadline=time.monotonic()+10
        while time.monotonic()<deadline:
            pump()
            ended,status=os.waitpid(pid,os.WNOHANG)
            if ended: break
        assert ended==pid,'Ctrl+C did not terminate consumer'
        assert os.waitstatus_to_exitcode(status)==0,'consumer nonzero exit\n'+plain()[-4000:]
        attrs=termios.tcgetattr(fd)
        assert attrs[3]&termios.ICANON,'canonical terminal mode was not restored'
        assert attrs[3]&termios.ECHO,'terminal echo was not restored'
        assert not os.path.exists(os.path.join(os.path.dirname(statepath),'state.lock')),'lock retained after normal exit'
        if config.get('capturePath'):
            with open(config['capturePath'],'ab') as capture: capture.write(output)
        return {'restart':restored,'exit':0,'terminal_restored':True}
    finally:
        if status is None:
            try: os.killpg(pid,signal.SIGTERM)
            except ProcessLookupError: pass
        os.close(fd)
results=[session(False),session(True)]
print(json.dumps(results))
`;

async function directory(path) { await mkdir(path, { recursive: true }); return path; }

test('one precompiled tarball works in isolated npm/Bun/local/global/npx/bunx consumers', { timeout: 900000 }, async t => {
  const evidence = await directory(join(repository, '.test-dist', 'consumer-evidence'));
  const capturePath = join(evidence, 'consumer.pty.log');
  const reportPath = join(evidence, 'package-consumer-report.json');
  await writeFile(capturePath, '');
  await writeFile(reportPath, JSON.stringify({ schemaVersion: 1, kind: 'package-consumer-report', status: 'running' }));
  const passedCases = [];
  const root = await mkdtemp(join(tmpdir(), 'terminal-world-consumers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sharedHome = await directory(join(root, 'tool-home'));
  const cache = await directory(join(root, 'cache'));
  const baseEnv = { ...process.env, HOME: sharedHome, npm_config_cache: join(cache, 'npm'), BUN_INSTALL_CACHE_DIR: join(cache, 'bun') };
  const producer = await directory(join(root, 'producer'));
  const [packed] = Object.values(JSON.parse(command('npm', ['pack', '--json', '--pack-destination', producer], { cwd: repository, env: baseEnv })));
  const tgz = resolve(producer, packed.filename);
  const bytes = await readFile(tgz);
  const digest = createHash('sha256').update(bytes).digest('hex');
  t.diagnostic(`tarball sha256=${digest}; files=${packed.files.map(file => file.path).join(',')}`);
  assert.ok(packed.files.some(file => file.path === 'dist/cli.js'));
  assert.ok(packed.files.every(file => file.path === 'package.json' || file.path === 'README.md' || file.path === 'LICENSE' || file.path.startsWith('dist/')));
  assert.ok(packed.files.every(file => !/\.(tsx?|map)$/.test(file.path)));
  assert.equal((await stat(join(repository, 'dist/cli.js'))).mode & 0o111, 0o111);
  const packedBin = packed.files.find(file => file.path === 'dist/cli.js');
  assert.ok((packedBin.mode & 0o111) !== 0, 'tarball bin itself has executable permission');
  assert.match(await readFile(join(repository, 'dist/cli.js'), 'utf8'), /^#!\/usr\/bin\/env node\n/);
  t.diagnostic(`Node ${process.version}; npm ${command('npm', ['--version']).trim()}; Bun ${command('bun', ['--version']).trim()}`);

  const npmLocal = await directory(join(root, 'npm-local'));
  const npmGlobal = await directory(join(root, 'npm-global'));
  const bunLocal = await directory(join(root, 'bun-local'));
  const bunGlobal = await directory(join(root, 'bun-global'));
  for (const folder of [npmLocal, bunLocal]) await writeFile(join(folder, 'package.json'), '{"private":true}\n');
  command('npm', ['install', '--prefix', npmLocal, '--omit=dev', '--no-audit', '--no-fund', tgz], { cwd: npmLocal, env: baseEnv });
  command('npm', ['install', '--global', '--prefix', npmGlobal, '--omit=dev', '--no-audit', '--no-fund', tgz], { cwd: npmGlobal, env: baseEnv });
  command('bun', ['add', tgz], { cwd: bunLocal, env: baseEnv });
  const globalDirectory = join(bunGlobal, 'packages');
  const globalBin = await directory(join(bunGlobal, 'bin'));
  const bunfig = join(root, 'bunfig.toml');
  await writeFile(bunfig, `[install]\nglobalDir = ${JSON.stringify(globalDirectory)}\nglobalBinDir = ${JSON.stringify(globalBin)}\n`);
  const globalEnv = { ...baseEnv, BUN_INSTALL_GLOBAL_DIR: globalDirectory, BUN_INSTALL_BIN: globalBin };
  command('bun', ['add', '--global', `--config=${bunfig}`, tgz], { cwd: bunGlobal, env: globalEnv });
  const npxCwd = await directory(join(root, 'npx'));
  const bunxCwd = await directory(join(root, 'bunx'));
  const consumers = [
    { name: 'npm-local', cwd: npmLocal, command: ['npm', 'exec', '--', 'terminal-world'] },
    { name: 'npm-global', cwd: npmGlobal, command: [join(npmGlobal, 'bin', 'terminal-world')] },
    { name: 'npx-tarball', cwd: npxCwd, command: ['npx', '--yes', '--package', tgz, 'terminal-world'] },
    { name: 'bun-local', cwd: bunLocal, command: ['bunx', '--no-install', 'terminal-world'] },
    { name: 'bun-global', cwd: bunGlobal, command: [join(globalBin, 'terminal-world')], env: globalEnv },
    { name: 'bunx-tarball', cwd: bunxCwd, command: ['bunx', '--package', tgz, 'terminal-world'] },
  ];
  for (const [index, consumer] of consumers.entries()) await t.test(consumer.name, async () => {
    const home = await directory(join(root, `home-${consumer.name}`));
    const env = { ...(consumer.env ?? baseEnv), HOME: home };
    const [executable, ...args] = consumer.command;
    assert.match(command(executable, [...args, '--help'], { cwd: consumer.cwd, env }), /Node.js 22|Node\.js 22/);
    assert.equal(command(executable, [...args, '--version'], { cwd: consumer.cwd, env }).trim(), '0.1.0');
    const noTTY = spawnSync(executable, args, { cwd: consumer.cwd, env, encoding: 'utf8', timeout: 180000 });
    assert.notEqual(noTTY.status, 0);
    assert.match(noTTY.stderr, /TTY/);
    await assert.rejects(stat(join(home, 'Library', 'Application Support', 'Terminal World')), { code: 'ENOENT' });
    const scenario = { command: consumer.command, cwd: consumer.cwd, nickname: `검증${index + 1}`, fullStory: index === 0, capturePath,
      ...(index === 0 ? { restartCwd: await directory(join(root, 'different-restart-cwd')), restartCommand: [join(npmLocal, 'node_modules', '.bin', 'terminal-world')] } : {}) };
    const results = JSON.parse(command('python3', ['-c', ttyScenario], { cwd: consumer.cwd, env: { ...env, TW_CONSUMER_SCENARIO: JSON.stringify(scenario) }, timeout: 240000 }));
    assert.equal(results.length, 2);
    assert.ok(results.every(result => result.exit === 0 && result.terminal_restored));
    t.diagnostic(`${consumer.name}: help/version/no-TTY + real PTY first commit/restart/cleanup passed`);
    if (index === 0) t.diagnostic('Full packed-app PTY scenario: profile5fields, three isolated guestbooks, chat,20dirty-route clicks/wheels,5resize cycles, different-cwd restart passed');
    passedCases.push(consumer.name);
  });
  await assert.rejects(stat(join(npmLocal, 'node_modules', 'typescript')), { code: 'ENOENT' });
  await assert.rejects(stat(join(npmLocal, 'node_modules', 'terminal-world-prototype', 'src')), { code: 'ENOENT' });

  await t.test('Node 22 runs the same packed JavaScript', async () => {
    const runtime = await directory(join(root, 'node22-runtime'));
    const runtimeName = `node-v22.23.4-${process.platform}-${process.arch}`;
    const archiveName = `${runtimeName}.tar.gz`;
    const baseURL = 'https://nodejs.org/dist/v22.23.4/';
    const sums = await fetch(baseURL + 'SHASUMS256.txt', { signal: AbortSignal.timeout(60000) });
    assert.ok(sums.ok, `runtime checksums HTTP ${sums.status}`);
    const checksum = (await sums.text()).split('\n').find(line => line.endsWith(`  ${archiveName}`))?.split(/\s+/)[0];
    assert.match(checksum ?? '', /^[a-f0-9]{64}$/);
    const response = await fetch(baseURL + archiveName, { signal: AbortSignal.timeout(120000) });
    assert.ok(response.ok, `runtime archive HTTP ${response.status}`);
    const runtimeArchive = Buffer.from(await response.arrayBuffer());
    assert.equal(createHash('sha256').update(runtimeArchive).digest('hex'), checksum);
    const archive = join(runtime, archiveName);
    await writeFile(archive, runtimeArchive);
    command('tar', ['-xzf', archive, '-C', runtime], { env: baseEnv });
    const node22 = join(runtime, runtimeName, 'bin', 'node');
    const version = command(node22, ['--version'], { env: baseEnv }).trim();
    assert.match(version, /^v22\./);
    const bin = await realpath(join(npmLocal, 'node_modules', '.bin', 'terminal-world'));
    assert.equal(command(node22, [bin, '--version'], { cwd: npxCwd, env: baseEnv }).trim(), '0.1.0');
    const home = await directory(join(root, 'home-node22'));
    const results = JSON.parse(command('python3', ['-c', ttyScenario], { cwd: npxCwd, env: { ...baseEnv, HOME: home, TW_CONSUMER_SCENARIO: JSON.stringify({ command: [node22, bin], cwd: npxCwd, nickname: '노드22' }) }, timeout: 180000 }));
    assert.equal(results.length, 2);
    t.diagnostic(`${version}: same-tarball first commit/restart and cleanup passed`);
    passedCases.push(version);
  });
  await t.test('Node shebang fails honestly when Node is absent', async () => {
    const emptyPath = await directory(join(root, 'without-node'));
    const binary = join(npmLocal, 'node_modules', '.bin', 'terminal-world');
    const result = spawnSync(binary, ['--help'], { env: { ...baseEnv, PATH: emptyPath }, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /node/i);
    passedCases.push('node-required');
  });
  await t.test('bunx honors the Node shebang instead of forcing Bun native', async () => {
    const instrumented = await directory(join(root, 'node-instrumentation'));
    const marker = join(root, 'node-was-used');
    await writeFile(join(instrumented, 'node'), `#!/bin/sh\nprintf '%s\\n' used >> ${JSON.stringify(marker)}\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
    const env = { ...baseEnv, PATH: `${instrumented}:${process.env.PATH}` };
    assert.equal(command('bunx', ['--no-install', 'terminal-world', '--version'], { cwd: bunLocal, env }).trim(), '0.1.0');
    assert.match(await readFile(marker, 'utf8'), /used/);
    passedCases.push('bunx-node-shebang');
  });
  await writeFile(reportPath, JSON.stringify({
    schemaVersion: 1, kind: 'package-consumer-report', status: passedCases.length === 9 ? 'passed' : 'failed',
    capturedAt: new Date().toISOString(), tarballSha256: digest, packageFiles: packed.files, passedCases,
    hostRuntime: process.version, npm: command('npm', ['--version']).trim(), bun: command('bun', ['--version']).trim(),
    invocation: 'npm run test:package', ptyCapture: 'consumer.pty.log',
    fullStory: 'profile customization, three target guestbooks, chat, 20 dirty-route clicks/wheels, five resize cycles, different-cwd restart',
    limitations: 'Synthetic PTY events, not physical macOS IME or Orca/Terminal.app pointer verification.',
  }, null, 2) + '\n');
});
