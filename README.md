# VS Code Updater

A VS Code extension that reloads a window after the Claude Code extension updates, but only when no Claude Code work is running in that window and you have been away from it, so that a new Claude Code tab never opens blank.

> **Unofficial.** Not affiliated with or endorsed by Anthropic. It reads Claude Code's session registry and transcript files, whose layout is undocumented and can change with any Claude Code update. **Verified on Windows only**; the macOS and Linux code path is tested only against sample `ps` output.

## The problem

VS Code updates Claude Code in the background while windows are open. Each open window keeps running the version it loaded, from that version's folder under `~/.vscode/extensions`. VS Code marks the old folder for removal, and the next time any VS Code instance starts, it deletes the folder. From then on a new Claude Code tab in a window still on the old version opens black, because its webview loads files from a folder that no longer exists. Tabs that were already open keep working.

`Developer: Reload Window` fixes it, because the reloaded window loads the new version. `Developer: Restart Extension Host` does not: the restarted host tries to load the deleted folder again.

You meet this most when several VS Code instances share one extensions folder, for example windows started with different `--user-data-dir` values: whenever one of them starts, it deletes the folder the others are still running from. With a single VS Code instance the old folder normally survives until you quit VS Code, and this extension then mainly applies Claude Code updates while you are away instead of at your next restart.

## What it does

Every window runs its own copy and decides only for itself, once a minute.

1. **Is this window stale?** The running version of a watched extension differs from the version listed in the extensions folder's `extensions.json`, or the running version's folder is gone. A status bar item appears (`Reload for claude-code <version>`, amber once the old folder is deleted); clicking it reloads after the work check in step 3.
2. **Are you away?** The window has been unfocused for 10 minutes (`idleMinutes`). A focused window is never reloaded by default.
3. **Is Claude Code working here?** There is no debug session and no running task, and every Claude Code session of this window is idle. A session is a `claude` process whose parent (or grandparent, behind a process wrapper) is this window's extension host. It counts as idle when its registry file `~/.claude/sessions/<pid>.json` (the one whose `procStart` matches the process start time) says `idle`, has said so for 60 seconds (`sessionIdleSeconds`), and no Claude Code tool shell runs under it (a child process whose command line contains `shell-snapshots` or `CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT`). The tool-shell check exists because a background Bash command or a Monitor leaves the registry at `idle` while its shell runs. A session with no matching registry file counts as working.
4. **Would every tab come back?** A restored Claude Code tab resumes its conversation only if the conversation is in Claude Code's session list. A conversation that another session started (through `SendMessage`) and that has no typed prompt and no title is left out of that list, so its tab would reopen empty. The extension reads the first and last 64 KB of each session's transcript and applies the list's rule, copied from Claude Code 2.1.310 and unchanged through 2.1.314. When such tabs are the only thing in the way, it writes Claude Code's own rename file for each of those conversations (`<projects>/<folder>/<sessionId>/custom-title.json`) with the title `[dispatch from <name>] <first line of the request>`, and then reloads. An existing title is never overwritten.
5. **Is the machine short of memory?** (Windows only.) No automatic reload while the commit charge is at or above 90% of the commit limit (`holdAtCommitPercent`). The two counters come with the process query of step 3; if they cannot be read, the window waits. On macOS and Linux this check is skipped.
6. After a random delay of up to 2 minutes (`maxJitterSeconds`), the checks run again, once more right before acting. Then the window takes a machine-wide reload slot, a folder in `~/.vscode-updater`, so that only one automatic reload is in progress at a time across all windows of all VS Code instances on the machine. A window that comes back from such a reload frees its slot 10 seconds after it starts; if it does not come back, the next reload waits between 30 and 60 seconds (one to two `minReloadGapSeconds`). Minimized windows reload slowly: in a test, 76 to 132 seconds passed between the reload and the extension starting again. Then the window runs `workbench.action.reloadWindow`.

While a session is working, the check interval doubles each time, up to 5 minutes. If a window comes back within 5 minutes still stale for the same update, it never reloads itself again for that update; it logs `reloadDidNotHelp` and shows a notification.

Each window also notices when something else keeps reloading it: after 3 or more reloads or restarts within 2 minutes that it did not request, it logs `externalReloadLoop` and shows a warning (at most once per 10 minutes per window). It does not change its own behavior; the warning is there so a loop caused by another extension or tool gets noticed.

## What a reload costs

Measured on Windows with Claude Code 2.1.309 to 2.1.312:

- **Unsent text in a Claude Code input box is lost.** This is why the window must be unfocused for 10 minutes first.
- Claude Code tabs come back with their conversations, under the same `sessionId`. A tab in the background is restored when you click it.
- Processes in the integrated terminal keep running.
- Scheduled work inside a session (`/loop`, `CronCreate`) lives only in that session's memory and ends with the reload. Nothing on disk shows it, so the extension cannot see it.
- **On Windows, other extensions' child processes can outlive the reload.** Windows does not end a process's children when the parent ends, so a server another extension started is left running if that extension does not stop it before its extension host goes away. Measured with the R extension (`reditorsupport.r` 3.2.2): its language server, started through the `R.exe` launcher, was left behind on every reload or close of a window with an R file open, 16 processes and 875 MB each time, and on one machine 180 such trees (93 GB) had built up. Setting `"r.rpath.windows"` to the `bin/x64/Rterm.exe` of your R installation (not `bin/R.exe`) makes the R servers end with the window. This cost is why reloads are spaced and held under memory pressure (steps 5 and 6). To look for leftovers, compare the number of `Rterm.exe` (or other language-server) processes with the number of open windows that use them.

## What it reads and writes

It reads `extensions.json`, the session registry, the process table (PowerShell `Get-CimInstance Win32_Process` on Windows, `ps` elsewhere), on Windows the commit charge (`Win32_OperatingSystem`, in the same query) and the first and last 64 KB of the transcripts of this window's sessions. The process query runs only while the window is stale and you are away. Nothing is sent over the network.

It writes:

- `~/.vscode-updater/logs/YYYY-MM-DD.jsonl`, one line per event (`activate`, `stale`, `gate`, `wouldReload`, `titled`, `reload`, `slotReleased`, `externalReloadLoop`, `reloadDidNotHelp`, `updated`, `error`), each with the machine name, the window's folder name and the extension host's pid. A `titled` line contains the title, which is the first line of a request. Logs are never rotated or deleted; a day with one update and 23 open windows wrote 84 KB.
- `~/.vscode-updater/reload-slot-<machine>-<gap>-<n>/`, one small folder per automatic reload, removed by later reloads once it is older than three gaps.
- `vscode-updater-activity.json` in each window's workspace storage (VS Code's own per-workspace folder; windows with no folder share one in the global storage): the window's last 10 activation and reload-request times.
- `custom-title.json` in Claude Code's project folder, only for the conversations described in step 4. Such a conversation then appears, titled, in Claude Code's history list, where it was missing before.

## Install

1. Download `vs-code-updater.vsix` from the [latest release](https://github.com/KisooLabs/vs-code-updater/releases/latest) and compare its SHA-256 with `SHA256.txt` in the same release (`Get-FileHash vs-code-updater.vsix` on Windows, `shasum -a 256 vs-code-updater.vsix` on macOS).
2. Optional, to watch it before it acts: create `~/.vscode-updater/config.json` containing `{"autoReload": false}`. It then only logs a `wouldReload` line where it would have reloaded; delete the key when the log looks right.
3. `code --install-extension vs-code-updater.vsix --force`. Open windows pick it up without a reload.
4. Check: run `VS Code Updater: Show this window's state` from the Command Palette. It prints the configuration, whether this window is stale, and each Claude Code session it found with its status.

## Configuration

`~/.vscode-updater/config.json`, one file per machine, read on every check by every window. Missing keys take these defaults:

```json
{
  "autoReload": true,
  "watch": ["anthropic.claude-code"],
  "idleMinutes": 10,
  "reloadWhenFocusedInactive": false,
  "pollSeconds": 60,
  "sessionIdleSeconds": 60,
  "maxJitterSeconds": 120,
  "minReloadGapSeconds": 30,
  "holdAtCommitPercent": 90
}
```

- `autoReload`: `false` logs `wouldReload` instead of reloading.
- `watch`: extension ids whose update makes a window stale.
- `reloadWhenFocusedInactive`: also reload a focused window after `idleMinutes` without input. Off because it is untested whether typing in the Claude Code panel counts as input for VS Code.
- `minReloadGapSeconds`: the minimum spacing of automatic reloads on the machine; `0` turns the spacing off. A manual reload from the status bar is never refused but is recorded, so automatic reloads keep their distance from it.
- `holdAtCommitPercent` (Windows): no automatic reload at or above this share of the commit limit; `100` never holds. A manual reload at that level asks first.
- Numbers are clamped: `pollSeconds` 5 to 3600, `idleMinutes` 0 to 1440, `holdAtCommitPercent` 50 to 100, the others 0 to 3600.

The configuration is a file in your home directory, not a VS Code setting, because windows with different `--user-data-dir` values have separate settings but share one home directory. `VSCODE_UPDATER_HOME` moves the config and the logs. `CLAUDE_CONFIG_DIR` is honored when looking for registry files and transcripts.

## Limitations

- **Undocumented internals.** The session registry and its `procStart` field, the transcript layout, the session-list rule and the rename file all belong to Claude Code and can change in any update. If one of them changes, the likely result is that sessions count as working and the window never reloads itself; `Show this window's state` prints the reason. The other failure, a reload that reopens a conversation's tab empty, is possible if the session-list rule changes.
- **Platforms.** VS Code 1.90 or later. Verified on Windows 11 through three real Claude Code updates. In the first two (23 and 16 open windows) every window came back on the new version, and every returning conversation kept its `sessionId`. In the third (2.1.312 to 2.1.314, the first with 0.3.0's spacing), nine windows reloaded one at a time between 11:51 and 13:11 as each was left alone, each came back on the new version within 5 to 8 seconds and then freed the slot for the next, and windows still in use kept waiting. macOS and Linux are untested on real machines. Remote windows (SSH, WSL, Dev Containers) are untested; there Claude Code runs on the remote side while this extension runs on the local side, finds no matching installed version, and is expected never to act.
- **Windows you keep in front.** A window reloads only after you leave it for 10 minutes, so a window you use all day stays on the old version until you reload it yourself (the status bar item does it after the work check).
- **Scheduled work** (`/loop`, `CronCreate`) is not protected, as described above.

## Development

- Tests: `cd extension && npm test` (Node 18 or later). Package: `npm run package`.
- `extension/lib/core.js` holds all decision logic with no VS Code or I/O dependency, `extension/lib/procs.js` the process query, `extension/extension.js` the VS Code side.
- Code comments that cite `DECISIONS Dn` or `MEASUREMENTS_20261024.md` refer to design notes kept in a private development repository.

## License

MIT, see [LICENSE](LICENSE).
