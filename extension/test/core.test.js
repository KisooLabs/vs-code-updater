const test = require('node:test');
const assert = require('node:assert');
const core = require('../lib/core');

const cfg = core.mergeConfig({ idleMinutes: 10, sessionIdleSeconds: 60 });
const NOW = 10_000_000_000;
const idleUser = { focused: false, active: false, unfocusedSince: NOW - 11 * 60000, inactiveSince: NOW - 11 * 60000 };
const stale = [{ id: 'anthropic.claude-code', running: '2.1.308', installed: '2.1.310', folderMissing: true }];
const idleSession = (kids = []) => ({ pid: 1, registry: { pid: 1, status: 'idle', statusUpdatedAt: NOW - 120000 }, kids });

test('mergeConfig keeps defaults, rejects bad types, clamps numbers', () => {
  const c = core.mergeConfig({ autoReload: true, idleMinutes: 'x', watch: ['Anthropic.Claude-Code', 'a.b'], pollSeconds: 0, maxJitterSeconds: 1e12 });
  assert.strictEqual(c.autoReload, true);
  assert.strictEqual(c.idleMinutes, 10);
  assert.strictEqual(c.pollSeconds, 5);
  assert.strictEqual(c.maxJitterSeconds, 3600);
  assert.deepStrictEqual(c.watch, ['anthropic.claude-code', 'a.b']);
  assert.strictEqual(core.mergeConfig(null).autoReload, true);
  assert.strictEqual(core.mergeConfig({ autoReload: false }).autoReload, false);
  assert.strictEqual(core.mergeConfig({ autoReload: 'false' }).autoReload, true);   // wrong type: the default stands
  assert.strictEqual(core.mergeConfig({ dryRun: true }).autoReload, true);          // the 0.1.0 key is ignored
});

test('staleList: version mismatch, missing folder, unknown id', () => {
  const inst = core.installedVersions([{ identifier: { id: 'Anthropic.claude-code' }, version: '2.1.310' }]);
  assert.strictEqual(core.staleList([{ id: 'anthropic.claude-code', version: '2.1.310', folderExists: true }], inst).length, 0);
  assert.strictEqual(core.staleList([{ id: 'anthropic.claude-code', version: '2.1.308', folderExists: true }], inst)[0].installed, '2.1.310');
  assert.strictEqual(core.staleList([{ id: 'anthropic.claude-code', version: '2.1.310', folderExists: false }], inst)[0].folderMissing, true);
  assert.strictEqual(core.staleList([{ id: 'x.y', version: '1', folderExists: false }], inst).length, 0);
});

test('isToolShell matches Claude Code tool shells, not MCP servers', () => {
  assert.ok(core.isToolShell('"C:\\Program Files\\Git\\bin\\bash.exe" -c "source /c/Users/k/.claude/shell-snapshots/snapshot-bash-1.sh"'));
  assert.ok(core.isToolShell('cmd.exe /d /s /c ""chcp.com" 65001 >nul & powershell.exe -Command "$__claudeCodeScript = $env:CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT'));
  assert.ok(!core.isToolShell('C:\\WINDOWS\\system32\\cmd.exe /d /s /c "npx ^"-y^" ^"@playwright/mcp@latest^"'));
  assert.ok(!core.isToolShell('python.exe -m citation_checker.server'));
  assert.ok(!core.isToolShell(null));
});

test('pickRegistry: start-time match, stale files, no start time', () => {
  const live = { pid: 7, procStart: '134373536235618873', status: 'busy', updatedAt: 1 };
  const old = { pid: 7, procStart: '134000000000000000', status: 'idle', updatedAt: 9 };
  assert.strictEqual(core.pickRegistry([old, live], 7, '134373536235618870'), live);
  assert.strictEqual(core.pickRegistry([old], 7, '134373536235618870'), null);
  assert.strictEqual(core.pickRegistry([old, live], 7, null), old);           // newest updatedAt when no start time
  const noStart = { pid: 7, status: 'idle', updatedAt: 3 };
  assert.strictEqual(core.pickRegistry([noStart], 7, '134373536235618870'), noStart);  // older files without procStart
  assert.strictEqual(core.pickRegistry([live], 8, null), null);
});

test('sessionBusy: status, recency, tool shell, missing registry', () => {
  assert.strictEqual(core.sessionBusy(idleSession(), NOW, cfg).busy, false);
  assert.strictEqual(core.sessionBusy({ pid: 1, registry: { status: 'busy', statusUpdatedAt: 0 }, kids: [] }, NOW, cfg).busy, true);
  assert.strictEqual(core.sessionBusy({ pid: 1, registry: { status: 'idle', statusUpdatedAt: NOW - 5000 }, kids: [] }, NOW, cfg).busy, true);
  assert.strictEqual(core.sessionBusy(idleSession([{ name: 'bash.exe', commandLine: 'bash -c "source x/shell-snapshots/s.sh"' }]), NOW, cfg).busy, true);
  assert.strictEqual(core.sessionBusy(idleSession([{ name: 'conhost.exe', commandLine: 'conhost.exe 0x4' }]), NOW, cfg).busy, false);
  assert.strictEqual(core.sessionBusy({ pid: 1, registry: null, kids: [] }, NOW, cfg).busy, true);
});

test('userIdle: unfocused long enough; focused path only when enabled', () => {
  assert.strictEqual(core.userIdle(idleUser, NOW, cfg).idle, true);
  assert.strictEqual(core.userIdle({ ...idleUser, unfocusedSince: NOW - 9 * 60000 }, NOW, cfg).idle, false);
  const focusedInactive = { focused: true, active: false, unfocusedSince: null, inactiveSince: NOW - 11 * 60000 };
  assert.strictEqual(core.userIdle(focusedInactive, NOW, cfg).idle, false);
  assert.strictEqual(core.userIdle(focusedInactive, NOW, { ...cfg, reloadWhenFocusedInactive: true }).idle, true);
  assert.strictEqual(core.userIdle({ ...focusedInactive, active: true, inactiveSince: null }, NOW, { ...cfg, reloadWhenFocusedInactive: true }).idle, false);
});

test('decide: order of gates and the reload case', () => {
  const base = { stale, user: idleUser, debugActive: false, tasksRunning: false, sessions: [idleSession()], failed: false, now: NOW, cfg };
  assert.strictEqual(core.decide({ ...base, stale: [] }).action, 'none');
  assert.strictEqual(core.decide(base).action, 'reload');
  assert.deepStrictEqual(core.decide({ ...base, sessions: null }).reasons, ['sessions not checked']);
  assert.strictEqual(core.decide({ ...base, user: { ...idleUser, focused: true } }).action, 'wait');
  assert.strictEqual(core.decide({ ...base, debugActive: true }).action, 'wait');
  assert.strictEqual(core.decide({ ...base, tasksRunning: true }).action, 'wait');
  const busy = core.decide({ ...base, sessions: [idleSession(), { pid: 2, registry: { status: 'busy' }, kids: [] }] });
  assert.strictEqual(busy.action, 'wait');
  assert.strictEqual(busy.sessionsBusy, true);
  assert.strictEqual(core.decide({ ...base, sessions: [] }).action, 'reload');
  assert.strictEqual(core.decide({ ...base, failed: true }).action, 'wait');
});

test('reloadFailed: only a fresh instance after a reload for the same target', () => {
  const key = core.targetKey(stale);
  const act = NOW;
  assert.strictEqual(core.reloadFailed({ target: key, t: act - 20000 }, key, act), true);
  assert.strictEqual(core.reloadFailed({ target: key, t: act - 6 * 60000 }, key, act), false);   // manual reload much later
  assert.strictEqual(core.reloadFailed({ target: key, t: act + 1000 }, key, act), false);        // another window's reload after this one started
  assert.strictEqual(core.reloadFailed({ target: 'other@1', t: act - 1000 }, key, act), false);
  assert.strictEqual(core.reloadFailed(undefined, key, act), false);
});

test('sessionsFromTable (macOS/Linux ps output), wrapper via registry candidates', () => {
  const ps = [
    '  500     1 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/x --type=utility',
    '  600   500 /Users/k/.vscode/extensions/anthropic.claude-code-2.1.310-darwin-arm64/resources/native-binary/claude --output-format stream-json',
    '  601   600 /bin/zsh -c source /Users/k/.claude/shell-snapshots/snapshot-zsh-1.sh && sleep 90',
    '  602   600 node /Users/k/mcp/server.js',
    '  650   500 /usr/local/bin/my-wrapper',
    '  651   650 /opt/claude-custom --output-format stream-json',
    '  700   999 /Users/k/.vscode/extensions/anthropic.claude-code-2.1.310-darwin-arm64/resources/native-binary/claude',
  ].join('\n');
  const s = core.sessionsFromTable(core.parsePs(ps), 500, [651, 700]);
  assert.deepStrictEqual(s.map((x) => x.pid).sort(), [600, 651]);
  const first = s.find((x) => x.pid === 600);
  assert.strictEqual(first.kids.length, 2);
  assert.strictEqual(core.sessionBusy({ ...first, registry: { status: 'idle', statusUpdatedAt: 0 } }, NOW, cfg).busy, true);
});

test('listedInSessionList mirrors Claude Code: typed prompt, title, peer-only', () => {
  const L = (o) => JSON.stringify(o);
  const typed = [L({ type: 'user', message: { content: 'fix the parser' } })].join('\n');
  const peerOnly = [
    L({ type: 'user', isMeta: true, origin: { kind: 'peer' }, message: { content: 'Another Claude session sent a message: <cross-session-message>do x</cross-session-message>' } }),
    L({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
    L({ type: 'user', origin: { kind: 'task-notification' }, message: { content: '<task-notification> <task-id>b1</task-id>' } }),
    L({ type: 'assistant', message: { content: [{ type: 'text', text: 'sleep done' }] } }),
  ].join('\n');
  const titled = peerOnly + '\n' + L({ type: 'summary', summary: 'Reply PONG-C to reload-restore test', leafUuid: 'x' });
  const command = L({ type: 'user', message: { content: '<command-name>/compact</command-name>' } });
  const side = L({ type: 'user', isSidechain: true, message: { content: 'hi' } });
  assert.strictEqual(core.listedInSessionList({ head: typed, tail: typed }), true);
  assert.strictEqual(core.listedInSessionList({ head: peerOnly, tail: peerOnly }), false);
  assert.strictEqual(core.listedInSessionList({ head: peerOnly, tail: titled }), true);
  assert.strictEqual(core.listedInSessionList({ head: peerOnly, tail: peerOnly, sidecarTitle: 'My task' }), true);
  assert.strictEqual(core.listedInSessionList({ head: command, tail: command }), true);
  assert.strictEqual(core.listedInSessionList({ head: side, tail: side }), false);
  assert.strictEqual(core.firstPrompt(peerOnly), '');
});

test('sessionBusy: a session whose tab would reopen empty blocks the reload', () => {
  assert.strictEqual(core.sessionBusy({ ...idleSession(), restorable: false }, NOW, cfg).busy, true);
  assert.strictEqual(core.sessionBusy({ ...idleSession(), restorable: true }, NOW, cfg).busy, false);
  assert.strictEqual(core.sessionBusy({ ...idleSession(), restorable: undefined }, NOW, cfg).busy, false);
});

test('dispatchTitle: header skipped, source folder named, plain and missing cases', () => {
  const peer = (body, fromName = 'my-app-75') => JSON.stringify({ type: 'user', isMeta: true, origin: { kind: 'peer' }, message: { content: `Another Claude session sent a message:\n<cross-session-message from="uds:x" from-name="${fromName}" from-mode="bypass">\n${body}\n</cross-session-message>\n\nThis came from another Claude session.` } });
  const d8 = peer(String.raw`Dispatched from the c:\Users\me\code\my-app session under owner approval given in that session on 2026-10-24; proceed without confirmation for the scope below.` + '\n\nScope: execute the RUN QUEUE in TODO.md');
  assert.strictEqual(core.dispatchTitle(d8, 'abc'), '[dispatch from my-app] Scope: execute the RUN QUEUE in TODO.md');
  assert.strictEqual(core.dispatchTitle(peer('remember the code word AMBER-19', 'vs-code-updater-ad'), 'abc'), '[dispatch from vs-code-updater-ad] remember the code word AMBER-19');
  assert.ok(core.dispatchTitle(peer('x'.repeat(200)), 'abc').endsWith('…'));
  assert.strictEqual(core.dispatchTitle('{"type":"assistant"}', '8ed1725f-4629'), '[dispatch] 8ed1725f');
});

test('decide: tabs that would reopen empty lead to title, working sessions still wait', () => {
  const base = { stale, user: idleUser, debugActive: false, tasksRunning: false, failed: false, now: NOW, cfg };
  const empty = { ...idleSession(), pid: 5, restorable: false };
  const t = core.decide({ ...base, sessions: [idleSession(), empty] });
  assert.strictEqual(t.action, 'title');
  assert.deepStrictEqual(t.pids, [5]);
  assert.strictEqual(core.decide({ ...base, sessions: [empty, { pid: 2, registry: { status: 'busy' }, kids: [] }] }).action, 'wait');
  assert.strictEqual(core.decide({ ...base, user: { ...idleUser, focused: true }, sessions: [empty] }).action, 'wait');
});
