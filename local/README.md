# Windows local deployment

[Подробная инструкция на русском](../docs/local-mcp-windows.ru.md)

This directory contains the deployment additions maintained by this fork. The upstream package name and npm release process are unchanged. Clone this repository and run its installer to use these additions; installing the upstream npm package alone does not include them.

```text
ChatGPT plugin for one computer
  -> private OpenAI MCP tunnel
  -> tunnel-client on that computer
  -> local/start-local.mjs
  -> upstream Desktop Commander stdio server
```

Use a separate tunnel and ChatGPT plugin for each computer. This deployment does not add a multi-host router or isolate concurrent chats sharing one stdio server. Files and processes on the same computer remain shared. Upstream configuration is also shared by the Windows user.

## Files

| File | Purpose |
|---|---|
| `windows/Install.ps1` | Download pinned, checksum-verified Windows x64 runtimes and build from the lockfile. |
| `windows/Build.ps1` | Install dependencies and rebuild this checkout. |
| `windows/Save-Key.ps1` | Store a runtime key with current-user Windows DPAPI; optional loopback browser form. |
| `windows/Tunnel.ps1` | Connect, inspect, stop, or diagnose this installation's tunnel. |
| `windows/Install-Autostart.ps1` | Register a hidden logon launcher for the current user. It is not a continuous watchdog. |
| `windows/Remove-Autostart.ps1` | Remove the logon task belonging to this checkout. |
| `start-local.mjs` | Disable Desktop Commander telemetry and remove tunnel/admin credentials before importing the MCP server. |
| `response-guard.mjs` | Bound SDK stdio responses to leave room under the tunnel response size limit. |
| `key-entry.mjs` | Single-use loopback form with Host, Origin and CSRF checks and a 15-minute lifetime. |
| `smoke-test.mjs` | Exercise the local MCP protocol and basic tools without connecting a tunnel. |

Machine configuration, runtimes, encrypted keys, profiles, logs and reports live in ignored **`<repository>/.local/`**. Never publish that directory. Copy source code between computers and create fresh credentials on each computer. DPAPI storage is not a sandbox against processes running as the same Windows user.

The response guard preserves normal responses. Oversized tool results become a clearly marked partial preview and retain the tool's original `isError` value. The operation may already have completed: do not replay a mutation simply to retrieve its output. Read existing output in smaller portions. Oversized resources receive a protocol error; oversized SDK notifications become short warnings. Code that writes directly to stdout bypasses this SDK guard and must enforce its own bounds.

## Verification

After installation, from the repository root in PowerShell 7:

```powershell
$cfg = Get-Content ./.local/config.json -Raw | ConvertFrom-Json
& $cfg.nodePath --test local/test/*.test.mjs
& $cfg.nodePath local/smoke-test.mjs
```

Unit tests use synthetic data and keys. The smoke test creates a unique temporary directory under `.local/tmp`, invokes local file and PowerShell tools, checks oversized output recovery, and removes only its own fixture. It does not load a runtime key, connect to OpenAI, change the global Desktop Commander configuration, or touch another running MCP process. The report is written to `.local/state/smoke-test-report.json`. A separate ChatGPT test is still required to verify the actual tunnel, account permissions and selected computer.

Custom tools can be added in upstream `src/tools/`, their schemas in `src/tools/schemas.ts`, and registration in `src/server.ts`. Rebuild and restart at a safe point, then refresh the plugin's tools in ChatGPT. Avoid unbounded inline results; prefer pagination or saved artifacts.
