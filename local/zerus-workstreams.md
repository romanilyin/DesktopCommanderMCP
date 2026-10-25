# Optional Zerus workstreams for ChatGPT Chat / Work / Codex Chat

This adapter uses existing Desktop Commander `start_process`; it does not change
or restart the MCP tunnel, add cloud credentials, or pretend to send messages to
ChatGPT. Each conversation explicitly chooses its kind, exact conversation URL,
workspace and `external/project/session` name. The receiver owns bounded durable
checkpoints, a cooperative inbox and exact-identity handoff receipts.

Use the actual `host` identity reported by the intended desktop/connector HGS
profile for `machine`; a phone display alias is not a replacement state owner.

Keep the adapter profile outside the source checkout and version it with the
reviewed clean `romanilyin/zerus` receiver. Local profile shape:

```json
{
  "schema_version": 1,
  "transport": "local",
  "hgs": "C:/Tools/Zerus/current/hgs.exe",
  "config_dir": "C:/Users/example/AppData/Local/ZerusFork/profile/config",
  "state_dir": "C:/Users/example/AppData/Local/ZerusFork/profile/state",
  "machine": "pc-a",
  "source_commit": "REPLACE_WITH_REVIEWED_40_HEX_COMMIT"
}
```

For `wsl-local`, `hgs`, `config_dir` and `state_dir` are absolute Linux paths;
add exact `distribution`, `user` and absolute `wsl_executable`. No SSH or default
distribution fallback exists. Each machine/user has its own state, profile and
Desktop Commander tunnel. Never copy tunnel credentials or a session database
onto another machine to make their identities match.

Run from PowerShell 7 via Desktop Commander:

```powershell
node C:/Tools/DesktopCommanderMCP/local/zerus-workstream.mjs `
  --profile C:/Tools/zerus-workstream.profile.json register `
  --input-file C:/Work/private/external-register.json
```

Payloads follow `hgs external` in Zerus `docs/external-workstreams.md`. Supported
adapter actions: register, inspect, checkpoint, inbox, ack, handoff, list, send
and history. Save each mutation payload with one request UUID before sending;
reuse the identical payload only to reconcile that exact operation. Never invent
a new UUID as an automatic retry after an uncertain outcome.

## Cooperative agent routine

At the start of a coding chat, inspect the exact workstream, verify its current
run/conversation IDs, then read its inbox. Reading does not acknowledge anything.
Before accepting a queued instruction, check its scope, current user intent and
normal tool permissions. Explicitly acknowledge `accepted`; report `completed`
or `failed` only after the corresponding outcome. An instruction in the inbox
is not permission to bypass a tool confirmation or broaden the user's request.

After a meaningful coding step and before ending the turn, write a checkpoint
containing verified progress, commit/test evidence and the next concrete step.
Poll the inbox at safe boundaries while actively working. This is not a daemon:
an idle, closed, rate-limited or context-exhausted chat cannot be woken by the
adapter. Mobile sends are queued locally, not delivered to ChatGPT.

Before moving to another chat, resolve queued/accepted instructions and perform
an explicit `handoff` with the old exact identity and the new conversation URL.
The workstream remains; its run/conversation identity rotates. Old messages and
late acknowledgements do not silently migrate. The next chat inspects the saved
checkpoint instead of relying on hidden context or reconstructing a transcript.
Source labels are owner-declared: Chat, Work and Codex Chat are never inferred
from model names or login type. Native Codex sessions remain separate.

## Verification

```text
node --test local/test/zerus-workstream.test.mjs
```

This optional script needs no MCP server restart and can be adopted independently
of a Desktop Commander binary upgrade. It only executes the explicitly selected
HGS command with literal argv; no shell interpolation, automatic task execution,
cloud login scraping, approval automation or service management is performed.
