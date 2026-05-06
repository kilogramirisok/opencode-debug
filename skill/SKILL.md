---
name: debug
useWhen: "message contains error messages, stack traces, failing tests, crashes, unexpected behavior, or user mentions debugging"
---

# Debug Skill

Runtime debugging workflow for OpenCode. Activates when the user reports a bug, error, crash, or unexpected behavior.

## Activation Triggers

This skill activates when the user:
- Shares an error message or stack trace
- Reports a failing test
- Describes unexpected behavior or crashes
- Asks to debug something
- Mentions "debug", "fix", "error", "crash", "bug", "failing"

## Workflow

1. **Quick Check** → Run `debug-quick-check` with the failing command
2. **If obvious** → Fix directly, verify, done
3. **If not obvious** → Follow the instrument-capture-analyze loop:
   a. `debug-instrument` → inject probes at suspected points
   b. `debug-run-and-capture` → reproduce the bug with probes active
   c. `debug-read-capture` → analyze the captured output
   d. Repeat (max 3 rounds) until root cause found
4. **Fix** → Make minimal, targeted fix based on evidence
5. **Verify** → Run the failing command again to confirm
6. **Cleanup** → `debug-cleanup` to remove all probes and leave codebase clean

## Key Principles

- **Evidence over intuition**: Every fix must be backed by runtime data
- **Minimal probes**: One hypothesis per instrumentation round
- **Always cleanup**: Never leave debug artifacts in the codebase
- **Max 3 rounds**: If stuck after 3 rounds, step back and reconsider approach

## Tools

- `debug-quick-check` — Fast command triage
- `debug-instrument` — Inject trace/log/timer/watch probes
- `debug-run-and-capture` — Run and capture full output
- `debug-read-capture` — Read/filter captured logs
- `debug-cleanup` — Remove probes and logs
