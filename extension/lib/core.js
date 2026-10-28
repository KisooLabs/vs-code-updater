// Pure decision logic for VS Code Updater (no vscode, no I/O), so every rule is unit-testable.
// The extension feeds it facts (running vs installed versions, this window's Claude Code sessions,
// user activity) and acts on the decision it returns.

const DEFAULTS = Object.freeze({
  autoReload: true,                     // false: only log "wouldReload", never reload (0.1.x defaulted to false; the 0.1.0 key dryRun is ignored)
  watch: ['anthropic.claude-code'],     // extension ids whose update triggers a reload
  idleMinutes: 10,                      // how long the window must be unfocused (or inactive) first
  reloadWhenFocusedInactive: false,     // also reload a focused window after idleMinutes without input
  pollSeconds: 60,
  sessionIdleSeconds: 60,               // a session must have been idle this long
  maxJitterSeconds: 120,                // random delay so many windows do not reload at once
});

const BOUNDS = { idleMinutes: [0, 1440], pollSeconds: [5, 3600], sessionIdleSeconds: [0, 3600], maxJitterSeconds: [0, 3600] };

function mergeConfig(raw) {
  const cfg = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return cfg;
  for (const k of Object.keys(DEFAULTS)) {
    if (!(k in raw)) continue;
    if (k === 'watch') {
      if (Array.isArray(raw.watch) && raw.watch.every((s) => typeof s === 'string')) cfg.watch = raw.watch.map((s) => s.toLowerCase());
    } else if (typeof DEFAULTS[k] === 'number') {
      if (typeof raw[k] === 'number' && Number.isFinite(raw[k])) cfg[k] = Math.min(BOUNDS[k][1], Math.max(BOUNDS[k][0], raw[k]));
    } else if (typeof raw[k] === typeof DEFAULTS[k]) {
      cfg[k] = raw[k];
    }
  }
  return cfg;
}

/** Map of lower-cased extension id -> version, from the extensions folder's extensions.json. */
function installedVersions(extensionsJson) {
  const out = new Map();
  if (!Array.isArray(extensionsJson)) return out;
  for (const e of extensionsJson) {
    const id = e && e.identifier && typeof e.identifier.id === 'string' ? e.identifier.id.toLowerCase() : null;
    if (id && typeof e.version === 'string') out.set(id, e.version);
  }
  return out;
}

/**
 * running: [{ id, version, folderExists }] for the watched extensions loaded in this window.
 * Stale = the installed version differs from the running one, or the running folder is gone.
 */
function staleList(running, installed) {
  const out = [];
  for (const r of running) {
    const inst = installed.get(r.id.toLowerCase());
    if (inst === undefined) continue;   // uninstalled or not managed in this folder: not our business
    if (inst !== r.version || r.folderExists === false) {
      out.push({ id: r.id, running: r.version, installed: inst, folderMissing: r.folderExists === false });
    }
  }
  return out;
}

const TOOL_SHELL = /shell-snapshots|CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT/i;

function isToolShell(commandLine) {
  return typeof commandLine === 'string' && TOOL_SHELL.test(commandLine);
}

/**
 * Pick the registry entry for one live session among the files found for its pid (several
 * session folders can hold a file with that pid, some left over from dead processes).
 * startTicks: the process's creation time as a Windows FILETIME string, or null where unknown.
 */
function pickRegistry(entries, pid, startTicks) {
  const mine = entries.filter((e) => e && Number(e.pid) === pid);
  if (!mine.length) return null;
  if (startTicks != null) {
    const want = BigInt(startTicks);
    const timed = mine.filter((e) => /^\d+$/.test(String(e.procStart || '')));
    if (timed.length) {
      const hit = timed.find((e) => { const d = BigInt(e.procStart) - want; return d <= 10000000n && d >= -10000000n; });
      return hit || null;   // files exist but none is from this process: treat as unknown
    }
  }
  return mine.reduce((a, b) => ((Number(b.updatedAt) || 0) > (Number(a.updatedAt) || 0) ? b : a));
}

// A restored Claude Code tab resumes its conversation only if the session appears in Claude Code's
// session list; otherwise it reopens empty. These mirror the list's inclusion rule, copied from Claude
// Code 2.1.310 (extension.js: P01, vP/dU, PP, X06) and unchanged through 2.1.312, which reads the first
// and last 64 KB of the transcript.
const TRANSCRIPT_WINDOW = 65536;
const WRAPPED = /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/;
const COMMAND_NAME = /<command-name>(.*?)<\/command-name>/;

function lastStringField(text, key) {
  const re = new RegExp(`"${key}": ?"((?:[^"\\\\]|\\\\.)*)"`, 'g');
  let m;
  let last;
  while ((m = re.exec(text))) last = m[1];
  return last;
}

function isPlainUserLine(line) {
  return (line.includes('"type":"user"') || line.includes('"type": "user"')) && !line.includes('"tool_result"')
    && !/"isMeta": ?true/.test(line) && !/"isCompactSummary": ?true/.test(line);
}

/** The first prompt a person typed (not a peer message, task notification or tool result), as Claude Code finds it. */
function firstPrompt(head) {
  let fallback = '';
  for (const line of head.split('\n')) {
    if (!isPlainUserLine(line)) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user' || o.isMeta === true || o.isCompactSummary === true || !o.message) continue;
    const c = o.message.content;
    const texts = [];
    if (typeof c === 'string') texts.push(c);
    else if (Array.isArray(c)) {
      if (c.some((b) => b && b.type === 'tool_result')) continue;
      for (const b of c) if (b && b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
    }
    for (const t of texts) {
      const z = t.replace(/\r?\n/g, ' ').trim();
      if (!z) continue;
      const cmd = COMMAND_NAME.exec(z);
      if (cmd) { if (!fallback) fallback = cmd[1]; continue; }
      if (/<bash-input>[\s\S]*?<\/bash-input>/.test(z)) return z;
      if (WRAPPED.test(z)) continue;
      return z;
    }
  }
  return fallback;
}

/** transcript: { head, tail, sidecarTitle } — head/tail are the first and last TRANSCRIPT_WINDOW bytes. */
function listedInSessionList({ head, tail, sidecarTitle }) {
  if (/"isSidechain": ?true/.test(head.split('\n')[0])) return false;
  if (lastStringField(tail, 'customTitle') || sidecarTitle || lastStringField(head, 'customTitle')) return true;
  if (lastStringField(tail, 'aiTitle') || lastStringField(head, 'aiTitle')) return true;
  if (lastStringField(tail, 'lastPrompt') || lastStringField(tail, 'summary')) return true;
  if (firstPrompt(head)) return true;
  return head.split('\n').some((l) => isPlainUserLine(l) && /"type": ?"(image|document)"/.test(l));
}

/**
 * A title for a conversation that another session started (DECISIONS D12, option B):
 * written as Claude Code's own rename file so the session enters the list and its tab survives a
 * reload. Built from the first line of the dispatched request, after the dispatch approval header.
 */
function dispatchTitle(head, sessionId) {
  for (const line of head.split('\n')) {
    if (!line.includes('cross-session-message')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user' || !o.message) continue;
    const c = o.message.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '';
    const m = /<cross-session-message([^>]*)>([\s\S]*?)<\/cross-session-message>/.exec(text);
    if (!m) continue;
    const lines = m[2].split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let source = null;
    const header = lines.length ? /^Dispatched from the (.+?) session under owner approval/.exec(lines[0]) : null;
    if (header) { source = header[1].split(/[\\/]/).filter(Boolean).pop(); lines.shift(); }
    const fromName = (/from-name="([^"]*)"/.exec(m[1]) || [])[1];
    let first = (lines[0] || '').replace(/\s+/g, ' ').replace(/[\x00-\x1f\x7f-\x9f]/g, '');
    if (first.length > 80) first = `${first.slice(0, 79)}…`;
    const tag = source ? `[dispatch from ${source}]` : fromName ? `[dispatch from ${fromName}]` : '[dispatch]';
    return first ? `${tag} ${first}` : tag;
  }
  return `[dispatch] ${String(sessionId || '').slice(0, 8)}`.trim();
}

/**
 * One Claude Code session of this window.
 * session: { pid, registry (parsed sessions/<pid>.json or null), kids: [{ name, commandLine }],
 *            restorable (false when it has a transcript that Claude Code's session list would leave out) }
 */
function sessionBusy(session, now, cfg) {
  const reg = session.registry;
  if (!reg) return { busy: true, reason: `pid ${session.pid}: no registry entry` };
  if (reg.status !== 'idle') return { busy: true, reason: `pid ${session.pid}: status ${reg.status}` };
  const since = Number(reg.statusUpdatedAt) || 0;
  if (now - since < cfg.sessionIdleSeconds * 1000) return { busy: true, reason: `pid ${session.pid}: idle for under ${cfg.sessionIdleSeconds}s` };
  const shell = (session.kids || []).find((k) => isToolShell(k.commandLine));
  if (shell) return { busy: true, reason: `pid ${session.pid}: tool shell running (${shell.name})` };
  if (session.restorable === false) return { busy: true, emptyTab: true, reason: `pid ${session.pid}: its tab would reopen empty (conversation not in Claude Code's session list yet)` };
  return { busy: false, reason: null };
}

/** user: { focused, active, unfocusedSince, inactiveSince } with timestamps in ms or null. */
function userIdle(user, now, cfg) {
  const need = cfg.idleMinutes * 60000;
  if (!user.focused) {
    if (user.unfocusedSince != null && now - user.unfocusedSince >= need) return { idle: true, reason: 'unfocused' };
    return { idle: false, reason: 'unfocused for under idleMinutes' };
  }
  if (!cfg.reloadWhenFocusedInactive) return { idle: false, reason: 'window focused' };
  if (user.active === false && user.inactiveSince != null && now - user.inactiveSince >= need) return { idle: true, reason: 'focused but inactive' };
  return { idle: false, reason: 'window focused and in use' };
}

function targetKey(stale) {
  return stale.map((s) => `${s.id.toLowerCase()}@${s.installed}`).sort().join(',');
}

/**
 * A reload that did not help: this window instance started within `windowMs` after a reload
 * recorded for the same target, and it is still stale for that target.
 */
function reloadFailed(lastAttempt, key, activatedAt, windowMs = 5 * 60000) {
  return !!(lastAttempt && lastAttempt.target === key && lastAttempt.t <= activatedAt && activatedAt - lastAttempt.t < windowMs);
}

/**
 * The whole gate, in cost order; sessions may be null when an earlier gate already failed
 * (the caller skips the process query then).
 * Returns { action: 'none' | 'wait' | 'reload', reasons: [] }.
 */
function decide({ stale, user, debugActive, tasksRunning, sessions, failed, now, cfg }) {
  if (!stale.length) return { action: 'none', reasons: [] };
  if (failed) return { action: 'wait', reasons: ['a reload did not clear this update; reload by hand'] };
  const reasons = [];
  const u = userIdle(user, now, cfg);
  if (!u.idle) reasons.push(u.reason);
  if (debugActive) reasons.push('debug session active');
  if (tasksRunning) reasons.push('task running');
  if (reasons.length) return { action: 'wait', reasons };
  if (!sessions) return { action: 'wait', reasons: ['sessions not checked'] };
  const titlePids = [];
  let working = false;
  for (const s of sessions) {
    const b = sessionBusy(s, now, cfg);
    if (!b.busy) continue;
    reasons.push(b.reason);
    if (b.emptyTab) titlePids.push(s.pid); else working = true;
  }
  if (working) return { action: 'wait', reasons, sessionsBusy: true };
  // Only tabs that would reopen empty stand in the way: title them, then reload (option B).
  if (titlePids.length) return { action: 'title', reasons, pids: titlePids };
  return { action: 'reload', reasons: [u.reason] };
}

/** Parse `ps -A -ww -o pid=,ppid=,command=` output (macOS/Linux) into [{ pid, ppid, commandLine }]. */
function parsePs(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), commandLine: m[3] });
  }
  return out;
}

const CLAUDE_BIN = /[\\/]native-binary[\\/]claude(\.exe)?(\s|"|$)/i;

/**
 * From a full process table, this window's Claude Code sessions and their direct children.
 * A session is a claude binary directly under the extension host, or a registry pid (candidates)
 * whose parent or grandparent is the host (covers claudeCode.claudeProcessWrapper).
 */
function sessionsFromTable(table, hostPid, candidates = []) {
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const ids = new Set(table.filter((p) => p.ppid === hostPid && CLAUDE_BIN.test(p.commandLine || '')).map((p) => p.pid));
  for (const c of candidates) {
    const p = byPid.get(c);
    if (!p) continue;
    const parent = byPid.get(p.ppid);
    if (p.ppid === hostPid || (parent && parent.ppid === hostPid)) ids.add(c);
  }
  return [...ids].map((pid) => ({
    pid,
    startTicks: null,
    kids: table.filter((p) => p.ppid === pid).map((p) => ({ name: (p.commandLine || '').split(/\s+/)[0], commandLine: p.commandLine })),
  }));
}

module.exports = { DEFAULTS, TRANSCRIPT_WINDOW, mergeConfig, installedVersions, staleList, isToolShell, pickRegistry, firstPrompt, listedInSessionList, dispatchTitle, sessionBusy, userIdle, targetKey, reloadFailed, decide, parsePs, sessionsFromTable };
