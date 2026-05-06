# opencode-debug

**Cursor-style debug agent for OpenCode** — inject probes into CLI and browser apps, capture runtime data, analyze and fix bugs automatically.

## Why?

Cursor's Debug Mode works by instrumenting code with probes that POST runtime data to a local HTTP server. This plugin gives OpenCode the same capability — plus CLI apps get automatic reproduction via shell access.

**Two modes:**
- **CLI mode** — for Node.js/Python/Go scripts, test suites, server apps. Agent runs the command itself, no user action needed.
- **Browser mode** — for React/Vue/Svelte apps. User reproduces the bug in their real browser (extensions, cookies, sessions intact). Probes POST data to the agent's HTTP server.

## Architecture

```
┌──────────────────────────────────────────────────┐
│                    OpenCode                       │
│                                                  │
│  ┌─────────┐    ┌───────────────────────────┐   │
│  │  debug   │    │    debug agent prompt     │   │
│  │  agent   │◄───│    (two-mode workflow)     │   │
│  └────┬─────┘    └───────────────────────────┘   │
│       │                                          │
│  ┌────▼──────────────────────────────────────┐   │
│  │              6 Tools                      │   │
│  │                                           │   │
│  │  debug-quick-check  ──► Fast triage       │   │
│  │  debug-server       ──► HTTP capture      │   │
│  │  debug-instrument   ──► Inject probes     │   │
│  │  debug-run-and-capture ─► Run + log       │   │
│  │  debug-read-capture ──► Filter output     │   │
│  │  debug-cleanup      ──► Remove probes     │   │
│  └───────────────────────────────────────────┘   │
│       │                                          │
│  ┌────▼──────────┐   ┌──────────────────┐        │
│  │ /tmp/opencode- │   │ http://localhost │        │
│  │ debug/*.log    │   │ :9514/capture    │        │
│  │ (CLI mode)     │   │ (browser mode)   │        │
│  └────────────────┘   └──────────────────┘        │
└──────────────────────────────────────────────────┘
```

## Tools

### `debug-quick-check`
Fast triage — runs a command, captures exit code/stderr, detects common error patterns (TypeError, ImportError, ECONNREFUSED, etc.). Use this first before the full workflow.

### `debug-server`
Start/stop the HTTP capture server for browser mode. Probes in your app POST runtime data here. Endpoints: `/capture`, `/status`, `/sessions`, `/session/:id`, `/shutdown`. CORS enabled — works with Vite, Next.js dev mode, any dev server.

### `debug-instrument`
Inject debug probes into source files. Two modes:

**CLI mode** (`mode: "cli"`) — `console.log` probes captured via stdout:
```js
/* @debug:loop-var:abc123 */
console.log("[DEBUG:loop-var]", JSON.stringify({i: i}))
```

**Browser mode** (`mode: "browser"`) — `fetch()` probes POST to debug server:
```js
// #region opencode-debug: loop-var
(function(){
  var _j = JSON.stringify({t:Date.now(), p:"loop-var", s:"abc123", d:{"i": i}});
  fetch("http://localhost:9514/capture", {method:"POST", body:_j, headers:{"Content-Type":"application/json"}, keepalive:true}).catch(function(){});
})();
// #endregion opencode-debug: loop-var
```

| Probe Type | What it does |
|------------|-------------|
| `trace` | Logs function entry with arguments |
| `log` | Logs variable/expression values |
| `timer` | Measures execution time (start + end) |
| `watch` | Logs expression value at that point |

Supports **TypeScript, JavaScript, Python, and Go**. Creates `.debug.bak` backups before modifying files.

### `debug-run-and-capture`
Run a shell command and capture all stdout/stderr to a session-scoped log file. Supports timeout, custom cwd, env vars, session reuse.

### `debug-read-capture`
Read and filter captured output. Two formats:
- `format: "raw"` — for CLI mode stdout capture
- `format: "structured"` — for browser mode JSON probe data

Supports keyword search, regex, line ranges.

### `debug-cleanup`
Remove all debug probes and stop the server. Handles both `/* @debug: */` markers (CLI) and `#region` blocks (browser). Can restore from `.bak`, remove logs, stop server, dry-run.

## Installation

```bash
opencode plugin opencode-debug
```

That's it. The tools auto-activate when OpenCode sees error messages.

## Usage

### CLI app debugging (fully automatic)
Just describe the bug:
> *"Running `node server.js` crashes with TypeError"*

The agent will triage, instrument, reproduce, analyze, fix, and cleanup — no user action needed.

### Browser app debugging (user reproduces)
> *"Clicking submit in src/Form.tsx crashes the app"*

The agent will start the debug server, inject `fetch()` probes, then say:
> **"Probes injected. Reproduce the bug in your browser."**

You use your real browser at `localhost:5173` as normal. The probes POST data back. The agent reads it, fixes the bug, cleans up.

## Comparison with Cursor Debug Mode

| Feature | Cursor | opencode-debug |
|---------|--------|---------------|
| Code exploration | ✅ IDE context | ✅ File access |
| Hypothesis generation | ✅ LLM | ✅ LLM |
| Code instrumentation | ✅ IDE extension | ✅ Comment markers + `fetch()` probes |
| Runtime capture (browser) | ✅ IDE debug server | ✅ HTTP capture server |
| Runtime capture (CLI) | ❌ | ✅ Shell pipes to log |
| Auto-reproduce (CLI) | ❌ User reproduces | ✅ Agent runs commands |
| Multi-language | ✅ VS Code debugger | ✅ TS/JS/Python/Go probes |
| Cleanup | ✅ Automatic | ✅ Marker + `#region` removal |
| Real browser (extensions, cookies) | ✅ User's browser | ✅ User's browser |

## Project Structure

```
opencode-debug/
├── src/
│   ├── index.ts              # Plugin entry point
│   └── tools/
│       ├── quick-check.ts    # Fast triage
│       ├── debug-server.ts   # HTTP capture server
│       ├── instrument.ts     # Probe injection (CLI + browser)
│       ├── run-and-capture.ts # Run + capture
│       ├── read-capture.ts   # Log reader (raw + structured)
│       └── cleanup.ts        # Probe removal + server stop
├── agent/
│   └── debug.md              # Debug agent system prompt
├── skill/
│   └── SKILL.md              # Auto-activation skill
├── package.json
├── tsconfig.json
└── README.md
```

## Verified Test Results

**Unit tests:** 16/16 passing (`npm run test`)

**Integration tests in OpenCode 1.14.39:**

1. ✅ Plugin loading — all 6 tools registered
2. ✅ Agent selection — `--agent debug` activates debug agent
3. ✅ Quick-check tool — detects TypeError, ImportError patterns
4. ✅ CLI mode workflow — instrument → run-and-capture → read → fix → cleanup
5. ✅ Browser mode workflow — server start → instrument → simulated POST → read structured data → cleanup + stop server
6. ✅ Skill auto-activation — default agent uses debug tools on error messages
7. ✅ Cleanup — removes both `/* @debug: */` markers and `#region` blocks

## License

MIT
