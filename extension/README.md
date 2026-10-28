# VS Code Updater (extension)

Reloads a VS Code window after Claude Code updates, only when no Claude Code work is running in that window and you have been away from it for 10 minutes, so that a new Claude Code tab never opens blank. Full description, configuration and limitations: <https://github.com/KisooLabs/vs-code-updater>.

Each window decides only for itself, once a minute. A Claude Code session counts as working while its registry entry (`~/.claude/sessions/<pid>.json`) is not `idle`, for 60 seconds after it turns idle, and while a Claude Code tool shell runs under it. A tab that would reopen empty after a reload (a conversation started by another session, with no typed prompt and no title) is given a title first, written as Claude Code's own rename file.

Configuration: `~/.vscode-updater/config.json` (`"autoReload": false` to only log). Logs: `~/.vscode-updater/logs/YYYY-MM-DD.jsonl`. Commands (Ctrl/Cmd+Shift+P): `VS Code Updater: Reload this window now`, `Show this window's state`, `Open log folder`.

Build: `npm test`, then `npm run package`; install with `code --install-extension <vsix> --force`.

Unofficial; not affiliated with or endorsed by Anthropic. It reads Claude Code's undocumented session registry and transcript layout, which a Claude Code update can change. Verified on Windows only. MIT licensed.
