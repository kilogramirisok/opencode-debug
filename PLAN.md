# Architecture Analysis & Rebuild Plan

## Problem

Current `opencode-debug` only captures stdout/stderr from shell commands. This works for CLI/server apps but is **completely blind to browser apps** — injected `console.log` probes fire in the browser console where the agent can't see them.

## How Cursor Does It (verified from official blog + forum + engineer analysis)

Sources: cursor.com/blog/debug-mode, davidgomes.com (Cursor engineer), forum.cursor.com/t/cursor-2-2-debug-mode

**Architecture (confirmed):**
1. Agent reads codebase, generates **multiple hypotheses** about the bug
2. Instruments code with `fetch()` POST calls to a **local HTTP server** spun up by Cursor
3. Also writes to a **local file** as secondary capture (confirmed by users: "streamed data to a file it could read")
4. User reproduces bug in their **real browser/dev environment** — probes fire, data POSTs back
5. Agent reads captured data, generates targeted fix (often 2-3 lines vs hundreds of speculative lines)
6. User verifies fix → agent removes all instrumentation → clean minimal diff

**Implementation details (from forum users who inspected the code):**
- Probes wrapped in collapsed `// #region agent log ... #endregion` blocks for readability
- In TypeScript/JS: `fetch("http://localhost:{port}/capture", ...)` with JSON payload
- In some languages/environments: writes to file instead of HTTP (language-specific fallback)
- **No LSP, no debugger protocol, no breakpoints** — purely text-based HTTP logging
- This is why it works for "basically any programming language, and any environment" (davidgomes quote)
- Android emulator gotcha: needs `10.0.2.2` instead of `127.0.0.1` (environment awareness needed)

**What makes it genius (davidgomes analysis):**
- "Cursor's Debug Mode could arguably have been called Instrumentation Mode"
- "All it does is make the agent aware of the actual runtime characteristics"
- "LLMs are really good at parsing text" — textual logs are the ideal format for LLM analysis
- Works across frontend<>backend boundaries — instruments both sides simultaneously
- Human-in-the-loop verification is critical — agent can't judge if fix "feels right"

## How Sentry/OTel Do Browser Instrumentation

**Sentry browser SDK:**
- `Sentry.init({ dsn: 'http://localhost:xxx' })` — sets up a transport URL
- Wraps `fetch`, `XMLHttpRequest`, `addEventListener`, `console.*` via monkey-patching
- Batches events and POSTs them via `fetch()` with `keepalive: true` (survives page navigation)
- Uses `navigator.sendBeacon()` as fallback for page unload

**OpenTelemetry browser:**
- `WebTracerProvider` with `OTLPTraceExporter` — sends trace data via HTTP
- Same pattern: instrument → collect → POST to collector endpoint

**Key patterns from these:**
- `keepalive: true` on fetch — ensures data arrives even if user navigates away
- `sendBeacon` fallback for page unload
- Batch events before sending (don't POST on every probe hit)
- Structured JSON payloads with metadata (timestamp, probe ID, session ID)

## Architecture Constraints from OpenCode Plugin API

From the `@opencode-ai/plugin` types:

**Plugin lifecycle:**
- `Plugin = (input: PluginInput, options?) => Promise<Hooks>`
- PluginInput gives us: `client`, `project`, `directory`, `worktree`, `serverUrl`, `$` (BunShell)
- No explicit "start/stop" lifecycle — plugin returns Hooks and lives for the session

**Available hooks:**
- `event` — generic event bus
- `config` — mutate config (add agents, tools)
- `tool` — register tools
- `"tool.execute.before"` / `"tool.execute.after"` — intercept tool calls
- `"command.execute.before"` — intercept commands
- `"shell.env"` — inject env vars into shell sessions

**No "shutdown" hook** — meaning we can't auto-cleanup when OpenCode exits. The debug server must be managed by tools (start/stop explicitly).

## CSP (Content-Security-Policy) Consideration

Modern web apps often have CSP headers like:
```
Content-Security-Policy: connect-src 'self' https://api.example.com
```
This blocks `fetch('http://localhost:9514')`. Solutions:
1. **Proxy through dev server** — Vite/webpack dev server can proxy `/__debug` → `localhost:9514`
2. **Instrument the dev server config** — add the proxy rule automatically
3. **User adds meta tag** — `<meta http-security-policy="...">` override
4. **Most dev setups don't enforce CSP** — Next.js dev mode, Vite, CRA don't set strict CSP by default

For v1, we document this. For v2, we auto-patch vite.config/next.config.

## Probe Design

### Old (stdout-based, CLI only):
```js
console.log("[DEBUG:loop-iteration:manual]", { i, value: items[i] });
```

### New (HTTP-based, Cursor-verified pattern):
```ts
// #region opencode-debug: loop-iteration
(function(){
  var _d = {t:Date.now(), p:"loop-iteration", s:"manual", d:{i:i, value:items[i]}};
  var _j = JSON.stringify(_d);
  if(typeof fetch==="function"){
    fetch("http://localhost:9514/capture",{method:"POST",body:_j,headers:{"Content-Type":"application/json"},keepalive:true}).catch(function(){});
  }
  if(typeof process!=="undefined"&&process.stdout){process.stdout.write("[DEBUG] "+_j+"\n");}
})();
// #endregion opencode-debug: loop-iteration
```

This matches Cursor's pattern (confirmed from forum):
- `#region` / `#endregion` blocks for collapsibility and easy cleanup
- IIFE avoids polluting local scope
- `fetch()` works in browser AND Node.js 18+
- `keepalive: true` survives page navigation
- `.catch(function(){})` never disrupts app execution
- Dual capture: HTTP POST to debug server + stdout fallback for environments where fetch fails
- Python/Go: similar pattern using `urllib`/`http.Post`

## Revised Architecture

```
┌─────────────────────────────────────────────────┐
│                 User's Browser                    │
│  ┌─────────────────────────────────────────────┐ │
│  │  Instrumented React/Vue/Next.js App          │ │
│  │                                               │ │
│  │  /* @debug:log:manual */                      │ │
│  │  fetch("http://localhost:9514/capture", {     │ │
│  │    method: "POST",                            │ │
│  │    body: JSON.stringify({                     │ │
│  │      probe: "loop-var",                       │ │
│  │      data: { i, value: items[i] }             │ │
│  │    })                                         │ │
│  │  })                                           │ │
│  └──────────────┬──────────────────────────────┘ │
└─────────────────┼───────────────────────────────┘
                  │ HTTP POST (user's browser, real session)
                  ▼
┌─────────────────────────────────────────────────┐
│         Debug Capture Server (localhost:9514)     │
│  ┌─────────────────────────────────────────────┐ │
│  │  POST /capture  → append to session log      │ │
│  │  GET  /status   → server health, session list│ │
│  │  GET  /session/:id → read captured data      │ │
│  │  DELETE /session/:id → clear session data    │ │
│  └─────────────────────────────────────────────┘ │
│  Storage: /tmp/opencode-debug/{sessionId}.log     │
└─────────────────────────────────────────────────┘
                  ▲
                  │ Tool calls from LLM agent
┌─────────────────┴───────────────────────────────┐
│              OpenCode Agent                        │
│  debug-server start — spins up HTTP server        │
│  debug-instrument — injects fetch-based probes     │
│  debug-run-and-capture — runs CLI commands (kept)  │
│  debug-read-capture — reads captured probe data    │
│  debug-cleanup — removes probes, stops server      │
└─────────────────────────────────────────────────┘
```

## Tool Changes

### NEW: `debug-server` tool
- `action: "start" | "stop" | "status"`
- `port?: number` (default: 9514, auto-find if taken)
- Spins up a lightweight HTTP server (Node `http.createServer`)
- `POST /capture` → receive probe data, append to log
- `GET /status` → show running sessions, port, probe count
- `GET /sessions` → list captured sessions
- Persists across tool calls (server ref stored in module scope)
- Returns the `debugUrl` so instrument knows where probes should POST

### REWRITTEN: `debug-instrument`
- Takes `debugUrl` from server (or user provides)
- Injects IIFE-wrapped `fetch(debugUrl + "/capture", ...)` probes
- Works identically for .ts/.js/.py/.go (generates language-appropriate HTTP calls)
- Python: `urllib.request.urlopen("http://localhost:9514/capture", json.dumps(data))`
- Go: `http.Post("http://localhost:9514/capture", "application/json", bytes.NewReader(data))`

### KEPT: `debug-run-and-capture`
- Still useful for CLI/server apps
- Now ALSO starts the debug server if not running, so CLI probes work too
- Captures both stdout/stderr AND probe data in the same session log

### UPDATED: `debug-read-capture`
- Reads structured JSON probe data from HTTP captures
- Can filter by probe name, time range, data content
- Formats output for LLM analysis

### UPDATED: `debug-cleanup`
- Removes probes (same as before)
- Optionally stops debug server
- Warns if server is still receiving data

### UPDATED: `debug-quick-check`
- No changes needed — pure CLI triage tool

## Workflow

### Browser app debugging:
1. Agent: `debug-server start` → "Debug server running on http://localhost:9514"
2. Agent: `debug-instrument` → injects fetch probes pointing to :9514
3. Agent tells user: "I've instrumented your app. Please reproduce the bug in your browser."
4. User clicks around in their browser (real browser, real extensions, real cookies)
5. Probes fire → POST data to :9514 → captured in session log
6. Agent: `debug-read-capture` → analyzes the probe data
7. Agent: fixes the bug
8. Agent: `debug-cleanup` → removes probes, stops server

### CLI/server app debugging (existing flow, enhanced):
1. Agent: `debug-server start` 
2. Agent: `debug-instrument` → injects probes
3. Agent: `debug-run-and-capture "node app.js"` → runs app, probes POST to server
4. Agent: `debug-read-capture` → analyzes
5. Fix, cleanup

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/tools/debug-server.ts` | **NEW** | HTTP capture server |
| `src/tools/instrument.ts` | **REWRITE** | HTTP-based probes |
| `src/tools/run-and-capture.ts` | **UPDATE** | Start server if needed |
| `src/tools/read-capture.ts` | **UPDATE** | Parse structured JSON |
| `src/tools/cleanup.ts` | **UPDATE** | Stop server option |
| `src/tools/quick-check.ts` | **KEEP** | No changes |
| `src/index.ts` | **UPDATE** | Add debug-server tool |
| `src/test.ts` | **REWRITE** | New test suite |
| `agent/debug.md` | **UPDATE** | Updated workflow docs |
| `README.md` | **UPDATE** | Architecture docs |
