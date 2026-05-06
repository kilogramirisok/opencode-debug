# opencode-debug

**Runtime debug agent for OpenCode** — inject probes, capture output, analyze, fix, cleanup.

A plugin that gives OpenCode the same kind of interactive debugging experience as Cursor's Debug Mode, but leveraging the CLI's unique advantage: full shell access to run apps, curl endpoints, and trigger tests without user intervention.

## Why?

Cursor's Debug Mode works because it can:
1. Explore the codebase and understand context
2. Hypothesize about root causes
3. Instrument code with temporary probes
4. Have the user reproduce the bug (captures runtime data via IDE extension)
5. Analyze the captured output
6. Make a targeted fix
7. Verify and clean up

OpenCode doesn't have an IDE extension to intercept runtime output — but it **does** have full shell access. This plugin turns that into an advantage: the agent can automatically run the failing command, curl the endpoint, trigger the test suite, etc., all without user intervention.

## Architecture

```
┌─────────────────────────────────────────────┐
│                  OpenCode                    │
│                                             │
│  ┌─────────┐    ┌──────────────────────┐   │
│  │  debug   │    │   debug agent prompt │   │
│  │  agent   │◄───│   (10-step workflow)  │   │
│  └────┬─────┘    └──────────────────────┘   │
│       │                                     │
│  ┌────▼─────────────────────────────────┐   │
│  │           5 Tools                    │   │
│  │                                      │   │
│  │  debug-quick-check ──► Fast triage   │   │
│  │  debug-instrument  ──► Inject probes │   │
│  │  debug-run-and-capture ─► Run + log  │   │
│  │  debug-read-capture ─► Filter output │   │
│  │  debug-cleanup     ──► Remove probes │   │
│  └──────────────────────────────────────┘   │
│       │                                     │
│  ┌────▼──────────┐                          │
│  │ /tmp/opencode- │  ◄── capture logs       │
│  │ debug/*.log    │  ◄── manifests           │
│  │ *.manifest     │                          │
│  └────────────────┘                          │
└─────────────────────────────────────────────┘
```

## Tools

### `debug-quick-check`
Fast triage — runs a command, captures exit code/stderr, detects common error patterns (TypeError, ImportError, ECONNREFUSED, etc.). Use this first before the full workflow.

### `debug-instrument`
Inject debug probes into source files using comment markers:

| Probe Type | Marker | What it does |
|------------|--------|-------------|
| `trace` | `/* @debug:trace */` | Logs function entry |
| `log` | `/* @debug:log */` | Logs variable/expression value |
| `timer` | `/* @debug:timer */` | Measures execution time |
| `watch` | `/* @debug:watch */` | Logs expression value at that point |

Supports **TypeScript, JavaScript, Python, and Go**. Creates `.debug.bak` backups before modifying files.

### `debug-run-and-capture`
Run a shell command and capture all stdout/stderr to a session-scoped log file. Supports:
- Timeout control
- Custom working directory
- Environment variable injection
- Session reuse (append multiple runs to same log)

Output goes to `/tmp/opencode-debug/{sessionId}.log`.

### `debug-read-capture`
Read and filter captured debug output:
- Keyword search (case-insensitive)
- Regex pattern matching
- Line range filtering
- Line-numbered output

### `debug-cleanup`
Remove all debug probes from source files. Can:
- Target a specific session's probes
- Remove all probes across all files
- Restore from `.bak` backups
- Remove capture log files
- Dry-run mode to preview changes

## Agent Workflow

The debug agent follows a 10-step evidence-based workflow:

```
UNDERSTAND → TRIAGE → INSTRUMENT → REPRODUCE → ANALYZE → (loop) → FIX → VERIFY → CLEANUP → SUMMARIZE
```

**Key rule:** Never fix without runtime evidence. Max 3 instrumentation rounds.

## Installation

### As an OpenCode plugin

1. Clone this repo:
```bash
git clone https://github.com/rolginroman/opencode-debug.git
cd opencode-debug
```

2. Build:
```bash
bun install
bun run build
```

3. Add to your project's `.opencode/plugins.json` or global config:
```json
{
  "plugins": [
    "file:///path/to/opencode-debug"
  ]
}
```

### Development

```bash
bun install
bun run typecheck
bun run build
bun run test
```

## Project Structure

```
opencode-debug/
├── src/
│   ├── index.ts              # Plugin entry point
│   └── tools/
│       ├── quick-check.ts    # Fast triage tool
│       ├── instrument.ts     # Probe injection tool
│       ├── run-and-capture.ts # Run + capture tool
│       ├── read-capture.ts   # Log reader/filter tool
│       └── cleanup.ts        # Probe removal tool
├── agent/
│   └── debug.md              # Debug agent system prompt
├── skill/
│   └── SKILL.md              # Auto-activation skill
├── package.json
├── tsconfig.json
└── README.md
```

## Learnings from Research

### No existing debug agent for OpenCode
Extensive search across the OpenCode ecosystem (awesome-opencode, opencode.cafe marketplace, GitHub) confirmed there's no runtime debugging plugin. The closest is `specialist-agent`'s `@doctor` agent, which only does static analysis.

### Cursor's debug advantage = IDE extension
Cursor intercepts runtime output via its VS Code extension — a debug server runs inside the IDE process. OpenCode doesn't have this, but has something better for CLI: full shell access.

### Plugin API (from studying opencode-froggy)
- Plugins export a default `Plugin` async function
- Tools use `tool()` from `@opencode-ai/plugin` with zod-style schema
- Agents loaded from markdown files in `agent/` directory
- Skills loaded from `skill/SKILL.md` with `useWhen` triggers
- Plugin hooks: `tool.execute.before`, `tool.execute.after`, `event`, `config`

### Marker-based instrumentation > AST
Using `/* @debug:id */` comment markers instead of AST transformation because:
- Works across all languages
- Easy to find and remove (just grep for `@debug:`)
- No dependency on language-specific parsers
- Sufficient for the probe types we need (trace, log, timer, watch)

### Session-scoped capture
Each debug session gets a unique ID. All probes, capture logs, and manifests are tied to this ID. This enables:
- Multiple debug sessions without interference
- Targeted cleanup of specific sessions
- Correlation between injected probes and captured output

## Comparison with Cursor Debug Mode

| Feature | Cursor | opencode-debug |
|---------|--------|---------------|
| Code exploration | ✅ IDE context | ✅ File access |
| Hypothesis generation | ✅ LLM | ✅ LLM |
| Code instrumentation | ✅ IDE extension | ✅ Comment markers |
| Runtime capture | ✅ IDE debug server | ✅ Shell pipes to log |
| Auto-reproduce | ❌ User reproduces | ✅ Agent runs commands |
| Endpoint testing | ❌ Manual | ✅ Auto-curl |
| Multi-language | ✅ VS Code debugger | ✅ TS/JS/Python/Go probes |
| Cleanup | ✅ Automatic | ✅ Marker-based removal |
| Test triggering | ❌ Manual | ✅ Agent runs test suite |

The key differentiator: **OpenCode can reproduce the bug automatically** without the user doing anything. Cursor needs the user to trigger the reproduction manually.

## License

MIT
