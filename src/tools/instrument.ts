/**
 * Inject debug probes into source files using HTTP-based capture.
 *
 * Probes POST runtime data to the debug capture server (or a user-specified URL),
 * making them work in BOTH browser and CLI environments.
 *
 * Matches Cursor's Debug Mode pattern:
 * - IIFE-wrapped fetch() calls that POST JSON to the capture server
 * - #region blocks for collapsibility and easy cleanup
 * - keepalive: true for browser navigation survival
 * - .catch() to never disrupt app execution
 * - Dual capture: HTTP POST + stdout fallback
 */
import { tool, type ToolContext } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs"
import { join, extname, basename } from "node:path"
import { getServerUrl } from "./debug-server"

const CAPTURE_DIR = join(process.env.RUNTIME_DIR ?? "/tmp", "opencode-debug")

export interface InstrumentArgs {
  /** File path to instrument */
  filePath: string
  /** Probe type */
  probeType: "trace" | "log" | "timer" | "watch"
  /** Line number to inject at (1-indexed) */
  lineNumber: number
  /** Variable name or expression to log/watch */
  expression?: string
  /** Session ID for correlating captures */
  sessionId?: string
  /** Function name (for trace probes) */
  functionName?: string
  /** Label for the probe */
  label?: string
  /** Override the capture server URL (default: auto-detected from debug-server) */
  captureUrl?: string
}

// ─── JS/TS probe generator (HTTP-based, Cursor pattern) ────────────────

function jsProbe(args: {
  probeType: string
  expr?: string
  fn?: string
  label: string
  sessionId: string
  captureUrl: string
}): string {
  const { probeType, expr, fn, label, sessionId, captureUrl } = args

  // Build the data object for each probe type
  let dataExpr: string
  switch (probeType) {
    case "trace":
      dataExpr = `{fn:"${fn ?? "anon"}",type:"enter"}`
      break
    case "log":
      dataExpr = expr ? `{${expr}}` : `{checkpoint:true}`
      break
    case "timer": {
      const varName = `__dt_${label.replace(/[^a-zA-Z0-9]/g, "_")}`
      // Timer is special: returns start + end probe pair
      return [
        `// #region opencode-debug: ${label}-timer-start`,
        `(function(){`,
        `  var _s=Date.now(),_n="${label}-start",_d={ms:0,phase:"start"};`,
        `  var _j=JSON.stringify({t:_s,p:_n,s:"${sessionId}",d:_d});`,
        `  if(typeof fetch==="function"){fetch("${captureUrl}/capture",{method:"POST",body:_j,headers:{"Content-Type":"application/json"},keepalive:true}).catch(function(){});}`,
        `  if(typeof process!=="undefined"&&process.stdout){process.stdout.write("[DEBUG] "+_j+"\\n");}`,
        `  var _e=Date.now();`,
        `  var _j2=JSON.stringify({t:_e,p:"${label}-end",s:"${sessionId}",d:{ms:_e-_s,phase:"end"}});`,
        `  if(typeof fetch==="function"){fetch("${captureUrl}/capture",{method:"POST",body:_j2,headers:{"Content-Type":"application/json"},keepalive:true}).catch(function(){});}`,
        `  if(typeof process!=="undefined"&&process.stdout){process.stdout.write("[DEBUG] "+_j2+"\\n");}`,
        `})();`,
        `// #endregion opencode-debug: ${label}-timer-start`,
      ].join("\n")
    }
    case "watch":
      dataExpr = expr ? `{expr:"${expr}",value:${expr}}` : `{watching:true}`
      break
    default:
      dataExpr = `{type:"${probeType}"}`
  }

  return [
    `// #region opencode-debug: ${label}`,
    `(function(){`,
    `  var _d=${dataExpr};`,
    `  var _j=JSON.stringify({t:Date.now(),p:"${label}",s:"${sessionId}",d:_d});`,
    `  if(typeof fetch==="function"){fetch("${captureUrl}/capture",{method:"POST",body:_j,headers:{"Content-Type":"application/json"},keepalive:true}).catch(function(){});}`,
    `  if(typeof process!=="undefined"&&process.stdout){process.stdout.write("[DEBUG] "+_j+"\\n");}`,
    `})();`,
    `// #endregion opencode-debug: ${label}`,
  ].join("\n")
}

// ─── Python probe generator (HTTP-based) ───────────────────────────────

function pyProbe(args: {
  probeType: string
  expr?: string
  label: string
  sessionId: string
  captureUrl: string
}): string {
  const { probeType, expr, label, sessionId, captureUrl } = args
  const url = `${captureUrl}/capture`

  let dataDict: string
  switch (probeType) {
    case "trace":
      dataDict = `{"type": "enter"}`
      break
    case "log":
      dataDict = expr ? `{${expr}}` : `{"checkpoint": True}`
      break
    case "timer":
      dataDict = `{"ms": 0, "phase": "start"}`
      break
    case "watch":
      dataDict = expr ? `{"expr": "${expr}", "value": ${expr}}` : `{"watching": True}`
      break
    default:
      dataDict = `{"type": "${probeType}"}`
  }

  return [
    `# @debug:${probeType}:${sessionId}`,
    `try:`,
    `    import json as _json, urllib.request as _ur`,
    `    _d=${dataDict}`,
    `    _j=_json.dumps({"t":__import__("time").time()*1000,"p":"${label}","s":"${sessionId}","d":_d}).encode()`,
    `    _r=_ur.Request("${url}",data=_j,headers={"Content-Type":"application/json"})`,
    `    _ur.urlopen(_r,timeout=2)`,
    `except Exception:`,
    `    print(f"[DEBUG] probe ${label} failed",flush=True)`,
  ].join("\n")
}

// ─── Go probe generator (HTTP-based) ───────────────────────────────────

function goProbe(args: {
  probeType: string
  expr?: string
  label: string
  sessionId: string
  captureUrl: string
}): string {
  const { probeType, expr, label, sessionId, captureUrl } = args

  let dataVal: string
  switch (probeType) {
    case "trace":
      dataVal = `fmt.Sprintf("type=enter")`
      break
    case "log":
      dataVal = expr ? `fmt.Sprintf("${expr}=%v", ${expr})` : `"checkpoint=true"`
      break
    case "watch":
      dataVal = expr ? `fmt.Sprintf("${expr}=%v", ${expr})` : `"watching=true"`
      break
    default:
      dataVal = `fmt.Sprintf("type=${probeType}")`
  }

  return [
    `// @debug:${probeType}:${sessionId}`,
    `func init() {`,
    `    go func() {`,
    `        _ = ${dataVal}`,
    `        _j, _ := json.Marshal(map[string]any{"t": time.Now().UnixMilli(), "p": "${label}", "s": "${sessionId}", "d": _})`,
    `        _, _ = http.Post("${captureUrl}/capture", "application/json", bytes.NewReader(_j))`,
    `    }()`,
    `}`,
  ].join("\n")
}

// ─── Probe selector ────────────────────────────────────────────────────

function generateProbe(filePath: string, args: {
  probeType: string
  expr?: string
  fn?: string
  label: string
  sessionId: string
  captureUrl: string
}): string {
  const ext = extname(filePath)
  switch (ext) {
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
      return jsProbe(args)
    case ".py":
      return pyProbe(args)
    case ".go":
      return goProbe(args)
    default:
      // Default to JS probe (works for .mjs, .cjs, etc.)
      return jsProbe(args)
  }
}

// ─── Tool definition ───────────────────────────────────────────────────

export const instrumentTool = tool({
  description:
    "Inject HTTP-based debug probes into source files. Probes POST runtime data to the debug capture server, " +
    "making them work in BOTH browser and CLI environments.\n\n" +
    "Supports 4 probe types:\n" +
    "- trace: logs function entry with context\n" +
    "- log: logs variable/expression values\n" +
    "- timer: measures execution time\n" +
    "- watch: tracks expression value changes\n\n" +
    "Works with TypeScript, JavaScript, Python, and Go. " +
    "IMPORTANT: Run debug-server start BEFORE injecting probes. " +
    "Probes are wrapped in #region blocks for easy cleanup via debug-cleanup.",
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
      .describe("Session ID for correlating captures (included in POST data)"),
    functionName: tool.schema
      .string()
      .optional()
      .describe("Function name for trace probes"),
    label: tool.schema
      .string()
      .optional()
      .describe("Label for the probe (shown in debug output)"),
    captureUrl: tool.schema
      .string()
      .optional()
      .describe("Override capture server URL (default: auto-detected from debug-server)"),
  },
  async execute(args: InstrumentArgs, _context: ToolContext): Promise<string> {
    if (!existsSync(CAPTURE_DIR)) mkdirSync(CAPTURE_DIR, { recursive: true })

    const filePath = args.filePath
    if (!existsSync(filePath)) {
      return `File not found: ${filePath}`
    }

    // Resolve capture URL: explicit override > running server > error
    const captureUrl = args.captureUrl ?? getServerUrl()
    if (!captureUrl) {
      return "Error: No debug server running. Run 'debug-server start' first, or provide captureUrl explicitly."
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
    const probeBlock = generateProbe(filePath, {
      probeType: args.probeType,
      expr: args.expression,
      fn: args.functionName,
      label: args.label ?? `L${args.lineNumber}`,
      sessionId,
      captureUrl,
    })

    // Detect indentation of the target line
    const targetLine = lines[args.lineNumber - 1]
    const indent = targetLine.match(/^(\s*)/)?.[1] ?? ""

    // Indent the probe block to match surrounding code
    const indentedProbe = probeBlock
      .split("\n")
      .map(line => line ? indent + line : line)
      .join("\n")

    // Insert probe block before the target line
    lines.splice(args.lineNumber - 1, 0, indentedProbe)

    writeFileSync(filePath, lines.join("\n"))

    // Record in manifest
    const manifestPath = join(CAPTURE_DIR, `${sessionId}.manifest`)
    if (!existsSync(manifestPath)) {
      writeFileSync(manifestPath, `=== opencode-debug manifest ===\n`)
    }
    appendFileSync(manifestPath, `${new Date().toISOString()} | ${filePath}:${args.lineNumber} | ${args.probeType}${args.expression ? ` | ${args.expression}` : ""} | server=${captureUrl}\n`)

    return JSON.stringify({
      success: true,
      filePath,
      injectedAt: args.lineNumber,
      probeType: args.probeType,
      captureUrl,
      backupPath: bakPath,
      sessionId,
      message: `Injected ${args.probeType} probe at line ${args.lineNumber} in ${basename(filePath)}. Probes will POST to ${captureUrl}/capture`,
    }, null, 2)
  },
})
