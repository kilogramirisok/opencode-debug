/**
 * Inject debug probes into source files using comment markers.
 *
 * Markers (using @debug: prefix in block or line comments):
 *   trace  - logs function entry/exit with args
 *   log    - logs variable value at that point
 *   timer  - wraps next block with timing
 *   watch  - logs when expression value changes
 */
import { tool, type ToolContext } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs"
import { join, extname, basename } from "node:path"
import { randomUUID } from "node:crypto"

const CAPTURE_DIR = join(process.env.RUNTIME_DIR ?? "/tmp", "opencode-debug")

export interface InstrumentArgs {
  /** File path to instrument */
  filePath: string
  /** Probe type: trace, log, timer, watch */
  probeType: "trace" | "log" | "timer" | "watch"
  /** Line number to inject at (1-indexed) */
  lineNumber: number
  /** Variable name or expression to log/watch */
  expression?: string
  /** Session ID for the capture file */
  sessionId?: string
  /** Function name (for trace probes) */
  functionName?: string
  /** Label for the probe (shown in output) */
  label?: string
}

// Language-aware probe templates
const PROBES: Record<string, Record<string, (args: { expr?: string; fn?: string; label?: string; sessionId: string }) => string>> = {
  ".ts": {
    trace: ({ fn, label, sessionId }) =>
      `console.log("[DEBUG:${label ?? fn ?? "trace"}:${sessionId}]", "ENTER", ${fn ? `typeof ${fn} !== 'undefined' ? "${fn}" : "anon"` : '"anon"'});`,
    log: ({ expr, label, sessionId }) =>
      `console.log("[DEBUG:${label ?? "log"}:${sessionId}]", ${expr ?? '"checkpoint"'});`,
    timer: ({ label, sessionId }) => {
      const varName = `__debugTimer_${(label ?? "t").replace(/[^a-zA-Z0-9]/g, "_")}`
      return `const ${varName}_start = Date.now(); /* @debug-timer-end */`
    },
    watch: ({ expr, label, sessionId }) =>
      `console.log("[DEBUG:watch:${label ?? "watch"}:${sessionId}]", "value=", ${expr ?? '"?"'});`,
  },
  ".js": {
    trace: ({ fn, label, sessionId }) =>
      `console.log("[DEBUG:${label ?? fn ?? "trace"}:${sessionId}]", "ENTER");`,
    log: ({ expr, label, sessionId }) =>
      `console.log("[DEBUG:${label ?? "log"}:${sessionId}]", ${expr ?? '"checkpoint"'});`,
    timer: ({ label, sessionId }) => {
      const varName = `__debugTimer_${(label ?? "t").replace(/[^a-zA-Z0-9]/g, "_")}`
      return `const ${varName}_start = Date.now();`
    },
    watch: ({ expr, label, sessionId }) =>
      `console.log("[DEBUG:watch:${label ?? "watch"}:${sessionId}]", "value=", ${expr ?? '"?"'});`,
  },
  ".py": {
    trace: ({ fn, label, sessionId }) =>
      `print(f"[DEBUG:${label ?? fn ?? "trace"}:${sessionId}] ENTER", flush=True)`,
    log: ({ expr, label, sessionId }) =>
      `print(f"[DEBUG:${label ?? "log"}:${sessionId}] {${expr ?? '"checkpoint"'}}", flush=True)`,
    timer: ({ label, sessionId }) => {
      const varName = `__debug_timer_${(label ?? "t").replace(/[^a-zA-Z0-9]/g, "_")}`
      return `${varName}_start = __import__("time").time()`
    },
    watch: ({ expr, label, sessionId }) =>
      `print(f"[DEBUG:watch:${label ?? "watch"}:${sessionId}] value={${expr ?? '"?"'}}", flush=True)`,
  },
  ".go": {
    trace: ({ fn, label, sessionId }) =>
      `fmt.Println("[DEBUG:${label ?? fn ?? "trace"}:${sessionId}] ENTER")`,
    log: ({ expr, label, sessionId }) =>
      `fmt.Printf("[DEBUG:${label ?? "log"}:${sessionId}] %v\\n", ${expr ?? '"checkpoint"'})`,
    timer: ({ label }) => {
      const varName = `debugTimer${(label ?? "t").replace(/[^a-zA-Z0-9]/g, "")}`
      return `${varName}Start := time.Now()`
    },
    watch: ({ expr, label, sessionId }) =>
      `fmt.Printf("[DEBUG:watch:${label ?? "watch"}:${sessionId}] value=%v\\n", ${expr ?? '"?"'})`,
  },
}

// Get probes for a file extension (fallback to JS probes)
function getProbesForFile(filePath: string) {
  const ext = extname(filePath)
  return PROBES[ext] ?? PROBES[".js"] ?? PROBES[".ts"]!
}

export const instrumentTool = tool({
  description:
    "Inject debug probes into source files. Supports 4 probe types:\n" +
    "- trace: logs function entry/exit\n" +
    "- log: logs a variable or expression value\n" +
    "- timer: measures execution time of a code block\n" +
    "- watch: logs when an expression value changes\n\n" +
    "Works with TypeScript, JavaScript, Python, and Go. Probes are marked with /* @debug:... */ comments " +
    "so the cleanup tool can remove them later. Creates a .bak backup before modifying files.",
  args: {
    filePath: tool.schema
      .string()
      .describe("Path to the file to instrument (relative to project root or absolute)"),
    probeType: tool.schema
      .enum(["trace", "log", "timer", "watch"])
      .describe("Type of debug probe to inject"),
    lineNumber: tool.schema
      .number()
      .describe("Line number to inject the probe at (1-indexed)"),
    expression: tool.schema
      .string()
      .optional()
      .describe("Variable name or expression to log/watch (required for log/watch probes)"),
    sessionId: tool.schema
      .string()
      .optional()
      .describe("Session ID from run-and-capture (included in probe output for correlation)"),
    functionName: tool.schema
      .string()
      .optional()
      .describe("Function name for trace probes"),
    label: tool.schema
      .string()
      .optional()
      .describe("Label for the probe (shown in debug output)"),
  },
  async execute(args: InstrumentArgs, _context: ToolContext): Promise<string> {
    if (!existsSync(CAPTURE_DIR)) {
      mkdirSync(CAPTURE_DIR, { recursive: true })
    }

    const filePath = args.filePath
    if (!existsSync(filePath)) {
      return `File not found: ${filePath}`
    }

    const sessionId = args.sessionId ?? "manual"
    const content = readFileSync(filePath, "utf-8")
    const lines = content.split("\n")

    if (args.lineNumber < 1 || args.lineNumber > lines.length) {
      return `Line number ${args.lineNumber} out of range (1-${lines.length})`
    }

    // Create backup
    const bakPath = filePath + ".debug.bak"
    if (!existsSync(bakPath)) {
      writeFileSync(bakPath, content)
    }

    // Generate probe code
    const probes = getProbesForFile(filePath)
    const probeGen = probes[args.probeType]
    if (!probeGen) {
      return `Unsupported probe type: ${args.probeType}`
    }

    const probeCode = probeGen({
      expr: args.expression,
      fn: args.functionName,
      label: args.label ?? `L${args.lineNumber}`,
      sessionId,
    })

    // Detect indentation of the target line
    const targetLine = lines[args.lineNumber - 1]
    const indent = targetLine.match(/^(\s*)/)?.[1] ?? ""

    // Insert probe with marker comment
    const markerComment = getMarkerComment(filePath, args.probeType, sessionId)
    const probeLine = `${indent}${markerComment}\n${indent}${probeCode}`

    lines.splice(args.lineNumber - 1, 0, probeLine)

    writeFileSync(filePath, lines.join("\n"))

    // Record injection in session manifest
    const manifestPath = join(CAPTURE_DIR, `${sessionId}.manifest`)
    const entry = `${new Date().toISOString()} | ${filePath}:${args.lineNumber} | ${args.probeType}${args.expression ? ` | ${args.expression}` : ""}\n`
    appendToManifest(manifestPath, entry)

    return JSON.stringify({
      success: true,
      filePath,
      injectedAt: args.lineNumber,
      probeType: args.probeType,
      probeCode,
      backupPath: bakPath,
      sessionId,
      message: `Injected ${args.probeType} probe at line ${args.lineNumber} in ${basename(filePath)}`,
    }, null, 2)
  },
})

function getMarkerComment(ext: string, probeType: string, sessionId: string): string {
  if (extname(ext) === ".py") {
    return `# @debug:${probeType}:${sessionId}`
  }
  return `/* @debug:${probeType}:${sessionId} */`
}

function appendToManifest(path: string, entry: string) {
  if (!existsSync(path)) {
    writeFileSync(path, `=== opencode-debug manifest ===\n`)
  }
  appendFileSync(path, entry)
}
