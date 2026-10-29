// Find this window's Claude Code sessions: claude processes whose parent (or, behind a process
// wrapper, grandparent) is this extension host, plus each session's direct children (tool shells
// show up there). Runs only while an update is pending and the cheaper gates have passed.
const { execFile } = require('child_process');
const { parsePs, sessionsFromTable } = require('./core');

const pidList = (pids) => pids.map((p) => String(Number(p))).filter((p) => /^\d+$/.test(p)).join(',');

const PS_WINDOWS = (hostPid, candidates) => `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$h = ${Number(hostPid)}
$cand = @(${pidList(candidates)})
$s = New-Object 'System.Collections.Generic.HashSet[int]'
Get-CimInstance Win32_Process -Filter "ParentProcessId=$h AND Name='claude.exe'" | ForEach-Object { [void]$s.Add([int]$_.ProcessId) }
if ($cand.Count -gt 0) {
  $cp = @(Get-CimInstance Win32_Process -Filter ((($cand | ForEach-Object { "ProcessId=$_" }) -join ' OR ')))
  $ppids = @($cp | Where-Object { [int]$_.ParentProcessId -ne $h } | ForEach-Object { [int]$_.ParentProcessId } | Select-Object -Unique)
  $pp = @{}
  if ($ppids.Count -gt 0) {
    Get-CimInstance Win32_Process -Filter ((($ppids | ForEach-Object { "ProcessId=$_" }) -join ' OR ')) | ForEach-Object { $pp[[int]$_.ProcessId] = [int]$_.ParentProcessId }
  }
  foreach ($p in $cp) { if ([int]$p.ParentProcessId -eq $h -or $pp[[int]$p.ParentProcessId] -eq $h) { [void]$s.Add([int]$p.ProcessId) } }
}
$ids = @($s)
$info = @(); $k = @()
if ($ids.Count -gt 0) {
  $info = @(Get-CimInstance Win32_Process -Filter ((($ids | ForEach-Object { "ProcessId=$_" }) -join ' OR ')) | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; start = [string]$_.CreationDate.ToFileTimeUtc() } })
  $k = @(Get-CimInstance Win32_Process -Filter ((($ids | ForEach-Object { "ParentProcessId=$_" }) -join ' OR ')) | ForEach-Object { [pscustomobject]@{ ppid = [int]$_.ParentProcessId; name = $_.Name; commandLine = [string]$_.CommandLine } })
}
$o = Get-CimInstance Win32_OperatingSystem -Property TotalVirtualMemorySize,FreeVirtualMemory
$commit = 1 - [double]$o.FreeVirtualMemory / [double]$o.TotalVirtualMemorySize

ConvertTo-Json -Compress -Depth 4 -InputObject @{ sessions = $info; kids = $k; commit = $commit }
`;

function run(file, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

/**
 * candidates: pids from Claude Code registry files (entrypoint claude-vscode), checked by ancestry.
 * Resolves to { sessions: [{ pid, startTicks (Windows FILETIME string or null), kids: [{ name, commandLine }] }],
 * commit (Windows: CommittedBytes / CommitLimit, null if absent; elsewhere null) }; rejects if the query fails.
 */
async function listSessions(hostPid, candidates = []) {
  if (process.platform === 'win32') {
    const encoded = Buffer.from(PS_WINDOWS(hostPid, candidates), 'utf16le').toString('base64');
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], 30000);
    const data = JSON.parse(out.trim() || '{}');
    const kids = asArray(data.kids);
    return {
      sessions: asArray(data.sessions).map((s) => ({
        pid: Number(s.pid),
        startTicks: s.start ? String(s.start) : null,
        kids: kids.filter((k) => Number(k.ppid) === Number(s.pid)).map((k) => ({ name: k.name, commandLine: k.commandLine || '' })),
      })),
      commit: typeof data.commit === 'number' ? data.commit : null,
    };
  }
  const out = await run('ps', ['-A', '-ww', '-o', 'pid=,ppid=,command='], 15000);
  return { sessions: sessionsFromTable(parsePs(out), hostPid, candidates.map(Number)), commit: null };
}

module.exports = { listSessions };
