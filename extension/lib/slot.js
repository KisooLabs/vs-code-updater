// Machine-wide spacing of automatic reloads. Every window of every VS Code instance shares one folder
// (~/.vscode-updater). An automatic reload first takes a time slot: a directory named for this machine,
// the gap and floor(now / gap). A slot is refused while the same or the previous slot is taken, so two
// automatic reloads are at least one gap apart (and at most two gaps, when windows are waiting).
// Directories because mkdir is atomic on Windows and POSIX alike; no lock is ever held, so a window
// that dies mid-way leaves nothing to clean up but an old slot, which expires by its name.
const fs = require('fs');
const path = require('path');

const PREFIX = 'reload-slot-';
const SLOT_RE = /^reload-slot-(.+)-(\d+)-(\d+)$/;
const DENIED = 'another window reloaded within minReloadGapSeconds';

const slotName = (host, gapSeconds, k) => `${PREFIX}${host}-${gapSeconds}-${k}`;

function removeOld(dir, host, now) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    const m = SLOT_RE.exec(n);
    if (!m || m[1] !== host) continue;
    const gapMs = Number(m[2]) * 1000;
    if (gapMs > 0 && now - Number(m[3]) * gapMs > 3 * gapMs) {
      try { fs.rmSync(path.join(dir, n), { recursive: true, force: true }); } catch { /* another window removed it */ }
    }
  }
}

/**
 * Take the slot for `now`. force (the manual command): record the slot if it is free, never refuse.
 * Returns { ok, slot (name or null), reason, near (the taken slot that refused it) }.
 */
function take(dir, { now, gapSeconds, host, window, pid, force = false }) {
  if (!(gapSeconds > 0)) return { ok: true, slot: null };
  fs.mkdirSync(dir, { recursive: true });
  removeOld(dir, host, now);
  const gapMs = gapSeconds * 1000;
  const k = Math.floor(now / gapMs);
  const at = (j) => path.join(dir, slotName(host, gapSeconds, j));
  const takenNear = (js) => js.find((j) => fs.existsSync(at(j)));
  if (!force) {
    const near = takenNear([k - 1, k]);
    if (near !== undefined) return { ok: false, slot: null, reason: DENIED, near: slotName(host, gapSeconds, near) };
  }
  try {
    fs.mkdirSync(at(k));
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return force ? { ok: true, slot: null } : { ok: false, slot: null, reason: DENIED, near: slotName(host, gapSeconds, k) };
  }
  if (!force) {
    // Two windows on either side of a slot boundary can both pass the check above before either
    // creates its slot; whichever looks second sees the other, so at most one of them proceeds.
    const near = takenNear([k - 1, k + 1]);
    if (near !== undefined) {
      try { fs.rmSync(at(k), { recursive: true, force: true }); } catch { /* ignore */ }
      return { ok: false, slot: null, reason: DENIED, near: slotName(host, gapSeconds, near) };
    }
  }
  try { fs.writeFileSync(path.join(at(k), 'owner.json'), JSON.stringify({ host, window, pid, t: now, manual: force })); } catch { /* the slot itself is the record */ }
  return { ok: true, slot: slotName(host, gapSeconds, k) };
}

/** End a slot early: the window that took it is back and has settled. */
function release(dir, slot) {
  if (!slot || !SLOT_RE.test(slot)) return false;
  try { fs.rmSync(path.join(dir, slot), { recursive: true, force: true }); return true; } catch { return false; }
}

module.exports = { take, release, slotName, DENIED };
