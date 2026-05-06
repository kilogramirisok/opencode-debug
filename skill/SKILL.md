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

## Two Modes

### CLI Mode (default)
For scripts, test suites, server apps, CLI tools. Agent reproduces automatically.

1. `debug-quick-check` → triage
2. `debug-instrument` (mode: "cli") → console.log probes
3. `debug-run-and-capture` → agent runs the command
4. `debug-read-capture` (format: "raw") → analyze
5. `debug-cleanup` → remove probes

### Browser Mode
For React/Vue/Svelte apps. User reproduces in their real browser.

1. `debug-quick-check` → triage
2. `debug-server` (action: "start") → start HTTP capture server
3. `debug-instrument` (mode: "browser") → fetch() probes
4. **Tell user: "Probes injected. Reproduce the bug in your browser."**
5. `debug-read-capture` (format: "structured") → analyze
6. `debug-cleanup` (stopServer: true) → remove probes + stop server

## Workflow

1. **Quick Check** → Run `debug-quick-check` with the failing command
2. **If obvious** → Fix directly, verify, done
3. **If not obvious** → Pick mode (CLI or browser), follow the loop:
   a. Instrument probes at suspected points
   b. Capture runtime data (auto-run for CLI, user reproduces for browser)
   c. Read and analyze captured output
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
- `debug-server` — HTTP capture server (browser mode)
- `debug-instrument` — Inject probes (CLI or browser mode)
- `debug-run-and-capture` — Run and capture full output
- `debug-read-capture` — Read/filter captured logs (raw or structured)
- `debug-cleanup` — Remove probes, logs, and stop server
