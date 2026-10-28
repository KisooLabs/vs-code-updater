// VS Code Updater: reload this window after Claude Code (or another watched extension) updates,
// but only when no Claude Code work is running here and the user is not using the window.
//
// Why a reload: an update leaves this window running the old version, and once another VS Code
// instance starts it deletes the old folder, so new Claude Code tabs here open blank. Reload Window
// loads the new version; Developer: Restart Extension Host does not (it reloads the deleted path).
// Measurements behind every rule: MEASUREMENTS_20261024.md in the design notes.
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('./lib/core');
const { listSessions } = require('./lib/procs');

const HOME = process.env.VSCODE_UPDATER_HOME || path.join(os.homedir(), '.vscode-updater');
const CONFIG_FILE = path.join(HOME, 'config.json');
const LOG_DIR = path.join(HOME, 'logs');
const MAX_BACKOFF_MS = 5 * 60000;

let ctx;
let statusItem;
let output;
let timer;
let polling = false;
let disposed = false;
let activatedAt = Date.now();
const user = { focused: true, active: true, unfocusedSince: null, inactiveSince: null };
const episode = { key: null, readyAt: null, lastLogged: null, wouldReloadLogged: false, failedNotified: false, backoff: 0 };

function windowLabel() {
  const f = vscode.workspace.workspaceFolders;
  return f && f.length ? f.map((x) => path.basename(x.uri.fsPath)).join('+') : '(no folder)';
}

function folderKey() {
  const f = vscode.workspace.workspaceFolders;
  return f && f.length ? f[0].uri.toString() : 'empty';
}

function pad(n) { return String(n).padStart(2, '0'); }

function log(event, data) {
  const d = new Date();
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const line = JSON.stringify({
    t: `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
    machine: os.hostname(), window: windowLabel(), host: process.pid, event, ...data,
  });
  output.appendLine(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, `${day}.jsonl`), line + '\n');
  } catch (e) {
    output.appendLine(`log write failed: ${e.message}`);
  }
}

function readConfig() {
  try { return core.mergeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); } catch { return core.mergeConfig(null); }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** The watched extensions loaded in this window, compared with what is installed on disk. */
function computeStale(cfg) {
  const out = [];
  const installedByDir = new Map();
  for (const id of cfg.watch) {
    const ext = vscode.extensions.getExtension(id);
    if (!ext) continue;
    const dir = path.dirname(ext.extensionPath);
    if (!installedByDir.has(dir)) installedByDir.set(dir, core.installedVersions(readJson(path.join(dir, 'extensions.json'))));
    out.push(...core.staleList([{ id, version: ext.packageJSON.version, folderExists: fs.existsSync(ext.extensionPath) }], installedByDir.get(dir)));
  }
  return out;
}

/** Every Claude Code session registry entry this machine has, from each folder a session may use. */
function registryEntries() {
  const dirs = new Set([path.join(os.homedir(), '.claude', 'sessions')]);
  if (process.env.CLAUDE_CONFIG_DIR) dirs.add(path.join(process.env.CLAUDE_CONFIG_DIR, 'sessions'));
  const out = [];
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(d).filter((n) => /^\d+\.json$/.test(n)); } catch { continue; }
    for (const n of names) {
      const j = readJson(path.join(d, n));
      if (j && Number(j.pid) === Number(n.slice(0, -5))) out.push(j);
    }
  }
  return out;
}

/** The session's transcript file, looked up under every config folder this window may use. */
function transcriptFor(sessionId, cwd) {
  const roots = new Set([path.join(os.homedir(), '.claude')]);
  if (process.env.CLAUDE_CONFIG_DIR) roots.add(process.env.CLAUDE_CONFIG_DIR);
  const name = `${sessionId}.jsonl`;
  const slug = typeof cwd === 'string' ? cwd.replace(/[^a-zA-Z0-9]/g, '-') : null;
  for (const r of roots) {
    const p = slug && path.join(r, 'projects', slug, name);
    if (p && fs.existsSync(p)) return p;
  }
  for (const r of roots) {
    let dirs = [];
    try { dirs = fs.readdirSync(path.join(r, 'projects')); } catch { continue; }
    for (const d of dirs) {
      const p = path.join(r, 'projects', d, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function headAndTail(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const n = core.TRANSCRIPT_WINDOW;
    const head = Buffer.alloc(Math.min(n, size));
    fs.readSync(fd, head, 0, head.length, 0);
    if (size <= n) return { head: head.toString('utf8'), tail: head.toString('utf8') };
    const tail = Buffer.alloc(n);
    fs.readSync(fd, tail, 0, n, size - n);
    return { head: head.toString('utf8'), tail: tail.toString('utf8') };
  } finally {
    fs.closeSync(fd);
  }
}

/** Would this session's tab come back with its conversation after a reload? (true when there is nothing to lose) */
function sessionRestorable(reg) {
  if (!reg || typeof reg.sessionId !== 'string') return undefined;
  const file = transcriptFor(reg.sessionId, reg.cwd);
  if (!file) return true;   // no transcript yet: an empty tab
  try {
    const sidecar = readJson(path.join(path.dirname(file), reg.sessionId, 'custom-title.json'));
    return core.listedInSessionList({ ...headAndTail(file), sidecarTitle: sidecar && typeof sidecar.customTitle === 'string' ? sidecar.customTitle : undefined });
  } catch {
    return false;
  }
}

async function windowSessions() {
  const entries = registryEntries();
  const candidates = [...new Set(entries.filter((e) => e.entrypoint === 'claude-vscode').map((e) => Number(e.pid)))];
  const sessions = await listSessions(process.pid, candidates);
  for (const s of sessions) {
    s.registry = core.pickRegistry(entries, s.pid, s.startTicks);
    s.restorable = sessionRestorable(s.registry);
  }
  return sessions;
}

/** Option B: give a conversation another session started Claude Code's own rename file, so its tab survives the reload. */
function writeDispatchTitle(session) {
  const reg = session.registry;
  if (!reg || typeof reg.sessionId !== 'string') return null;
  const file = transcriptFor(reg.sessionId, reg.cwd);
  if (!file) return null;
  const dir = path.join(path.dirname(file), reg.sessionId);
  const sidecar = path.join(dir, 'custom-title.json');
  if (fs.existsSync(sidecar)) return null;   // never overwrite a title the user or Claude Code set
  const title = core.dispatchTitle(headAndTail(file).head, reg.sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${sidecar}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ customTitle: title }));
  fs.renameSync(tmp, sidecar);
  log('titled', { pid: session.pid, sessionId: reg.sessionId, title });
  return title;
}

function titleEmptyTabs(sessions, pids) {
  for (const s of sessions) {
    if (!pids.includes(s.pid)) continue;
    try { writeDispatchTitle(s); } catch (e) { log('error', { message: `title write failed for pid ${s.pid}: ${e.message}` }); }
  }
}

function showStatus(stale, reasons = []) {
  if (!stale.length) { statusItem.hide(); return; }
  const s = stale[0];
  const broken = stale.some((x) => x.folderMissing);
  const emptyTab = reasons.some((r) => r.includes('would reopen empty'));
  statusItem.text = `$(sync) Reload for ${s.id.split('.').pop()} ${s.installed}`;
  statusItem.tooltip = `${stale.map((x) => `${x.id}: running ${x.running}, installed ${x.installed}`).join('\n')}\n`
    + (broken ? 'The running version\'s folder has been deleted, so new tabs of it will open blank.\n'
      : 'New tabs can open blank once another VS Code window starts and deletes the old version.\n')
    + 'This window reloads by itself when no Claude Code work is running and you are away. Click to reload now.'
    + (reasons.length ? `\nWaiting: ${reasons.join('; ')}` : '')
    + (emptyTab ? '\nA Claude Code tab here was started by another session and has no typed prompt or title, so a plain reload (manual too) would reopen it empty. Before reloading, this extension gives that conversation a title from its first request, so the tab comes back with it.' : '');
  statusItem.backgroundColor = broken ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  statusItem.show();
}

function liveFacts(stale, cfg, sessions, failed) {
  return {
    stale, cfg, sessions, failed, now: Date.now(), user: { ...user },
    debugActive: !!vscode.debug.activeDebugSession,
    tasksRunning: vscode.tasks.taskExecutions.length > 0,
  };
}

async function poll() {
  if (polling || disposed) return;
  polling = true;
  const cfg = readConfig();
  let delay = cfg.pollSeconds * 1000;
  try {
    const stale = computeStale(cfg);
    showStatus(stale);
    if (!stale.length) {
      if (episode.key) log('updated', { note: 'no longer stale' });
      Object.assign(episode, { key: null, readyAt: null, lastLogged: null, wouldReloadLogged: false, failedNotified: false, backoff: 0 });
      return;
    }
    const key = core.targetKey(stale);
    if (episode.key !== key) {
      Object.assign(episode, { key, readyAt: null, lastLogged: null, wouldReloadLogged: false, failedNotified: false, backoff: 0 });
      log('stale', { stale, autoReload: cfg.autoReload });
    }
    const failed = core.reloadFailed(ctx.globalState.get(`attempt:${folderKey()}`), key, activatedAt);
    if (failed && !episode.failedNotified) {
      episode.failedNotified = true;
      log('reloadDidNotHelp', { stale });
      vscode.window.showWarningMessage(`VS Code Updater: this window was reloaded for ${key} but still runs the old version. Automatic reload is off for this update; reload by hand if needed.`);
    }
    let facts = liveFacts(stale, cfg, null, failed);
    let d = core.decide(facts);
    if (d.action === 'wait' && d.reasons.length === 1 && d.reasons[0] === 'sessions not checked') {
      try {
        facts = liveFacts(stale, cfg, await windowSessions(), failed);
        d = core.decide(facts);
      } catch (e) {
        d = { action: 'wait', reasons: [`session query failed: ${String(e.message).split('\n')[0]}`], sessionsBusy: true };
      }
    }
    showStatus(stale, d.action !== 'reload' ? d.reasons : []);
    const summary = `${d.action}:${d.reasons.join('|')}`;
    if (summary !== episode.lastLogged) {
      episode.lastLogged = summary;
      log('gate', { action: d.action, reasons: d.reasons, sessions: facts.sessions ? facts.sessions.map((s) => ({ pid: s.pid, status: s.registry && s.registry.status, restorable: s.restorable, kids: s.kids.map((k) => k.name) })) : undefined });
    }
    if (d.sessionsBusy) {
      episode.backoff = Math.min(episode.backoff + 1, 6);
      delay = Math.min(delay * 2 ** episode.backoff, Math.max(delay, MAX_BACKOFF_MS));
    } else {
      episode.backoff = 0;
    }
    if (d.action !== 'reload' && d.action !== 'title') { episode.readyAt = null; return; }
    if (episode.readyAt == null) {
      episode.readyAt = Date.now() + Math.random() * cfg.maxJitterSeconds * 1000;
      delay = Math.min(delay, Math.max(1000, episode.readyAt - Date.now()));
      return;
    }
    if (Date.now() < episode.readyAt) return;
    if (d.action === 'title') {
      if (!cfg.autoReload) {
        if (!episode.wouldReloadLogged) { episode.wouldReloadLogged = true; log('wouldReload', { reasons: d.reasons, note: `autoReload is off; would first title ${d.pids.length} tab(s) started by another session` }); }
        delay = Math.max(delay, MAX_BACKOFF_MS);
        return;
      }
      titleEmptyTabs(facts.sessions, d.pids);
      facts = liveFacts(stale, cfg, await windowSessions(), failed);
      d = core.decide(facts);
      if (d.action !== 'reload') {
        log('gate', { action: d.action, reasons: d.reasons, note: 'after titling' });
        episode.readyAt = null;
        return;
      }
    }
    // The session query can take seconds; the user may have come back meanwhile.
    const last = core.decide(liveFacts(stale, cfg, facts.sessions, failed));
    if (last.action !== 'reload') {
      log('gate', { action: last.action, reasons: last.reasons, note: 'changed just before reload' });
      episode.readyAt = null;
      return;
    }
    if (!cfg.autoReload) {
      if (!episode.wouldReloadLogged) { episode.wouldReloadLogged = true; log('wouldReload', { reasons: last.reasons, note: 'autoReload is off' }); }
      delay = Math.max(delay, MAX_BACKOFF_MS);   // nothing more to learn each minute; keep the process queries rare
      return;
    }
    await ctx.globalState.update(`attempt:${folderKey()}`, { target: key, t: Date.now() });
    log('reload', { reasons: last.reasons, stale });
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  } catch (e) {
    log('error', { message: String(e && e.stack || e) });
  } finally {
    polling = false;
    clearTimeout(timer);
    if (!disposed) timer = setTimeout(poll, delay);
  }
}

async function reloadNow() {
  let sessions = [];
  let busy = [];
  try {
    const cfg = readConfig();
    sessions = await windowSessions();
    busy = sessions.map((s) => ({ pid: s.pid, ...core.sessionBusy(s, Date.now(), { ...cfg, sessionIdleSeconds: 0 }) })).filter((b) => b.busy);
  } catch (e) {
    busy = [{ reason: `could not check Claude Code sessions (${String(e.message).split('\n')[0]})` }];
  }
  const working = busy.filter((b) => !b.emptyTab).map((b) => b.reason);
  if (working.length) {
    const pick = await vscode.window.showWarningMessage(`Claude Code work is running in this window:\n${working.join('\n')}\nReloading stops it.`, { modal: true }, 'Reload anyway');
    if (pick !== 'Reload anyway') return;
  }
  titleEmptyTabs(sessions, busy.filter((b) => b.emptyTab).map((b) => b.pid));
  log('reload', { reasons: ['manual'], busy: busy.map((b) => b.reason) });
  await vscode.commands.executeCommand('workbench.action.reloadWindow');
}

async function showState() {
  const cfg = readConfig();
  let sessions;
  try { sessions = await windowSessions(); } catch (e) { sessions = `query failed: ${e.message}`; }
  output.appendLine(JSON.stringify({ home: HOME, config: cfg, user, activatedAt, stale: computeStale(cfg), sessions, episode }, null, 2));
  output.show(true);
}

function trackUser(state) {
  const now = Date.now();
  if (state.focused !== user.focused) user.unfocusedSince = state.focused ? null : now;
  const active = state.active === undefined ? state.focused : state.active;
  if (active !== user.active) user.inactiveSince = active ? null : now;
  user.focused = state.focused;
  user.active = active;
}

function activate(context) {
  ctx = context;
  activatedAt = Date.now();
  output = vscode.window.createOutputChannel('VS Code Updater');
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
  statusItem.command = 'vscodeUpdater.reloadNow';
  const start = vscode.window.state;
  user.focused = start.focused;
  user.active = start.active === undefined ? start.focused : start.active;
  user.unfocusedSince = start.focused ? null : activatedAt;
  user.inactiveSince = user.active ? null : activatedAt;
  context.subscriptions.push(
    output, statusItem,
    vscode.window.onDidChangeWindowState(trackUser),
    vscode.commands.registerCommand('vscodeUpdater.reloadNow', reloadNow),
    vscode.commands.registerCommand('vscodeUpdater.showState', showState),
    vscode.commands.registerCommand('vscodeUpdater.openLogs', () => {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      return vscode.env.openExternal(vscode.Uri.file(LOG_DIR));
    }),
    { dispose: () => { disposed = true; clearTimeout(timer); } },
  );
  const cfg = readConfig();
  log('activate', { version: context.extension.packageJSON.version, autoReload: cfg.autoReload, watch: cfg.watch.map((id) => ({ id, version: (vscode.extensions.getExtension(id) || { packageJSON: {} }).packageJSON.version })) });
  timer = setTimeout(poll, 5000);
}

function deactivate() { disposed = true; clearTimeout(timer); }

module.exports = { activate, deactivate };
