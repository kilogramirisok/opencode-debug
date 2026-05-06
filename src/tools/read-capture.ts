/**
 * Read and filter captured debug output.
 * Handles both HTTP capture (structured JSON from probes) and shell capture (stdout/stderr).
 */
import { tool, type ToolContext } from "@opencode-ai/plugin"
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const CAPTURE_DIR = join(process.env.RUNTIME_DIR ?? "/tmp", "opencode-debug")

export interface ReadCaptureArgs {
  /** Session ID to read (or 'latest' for most recent) */
  sessionId: string
  /** Filter by keyword */
  keyword?: string
  /** Filter by regex pattern */
  pattern?: string
  /** Only show lines after this line number (1-indexed) */
  afterLine?: number
  /** Only show lines before this line number */
  beforeLine?: number
  /** Maximum number of matching lines to return (default: 200) */
  maxLines?: number
  /** Output format: raw (original text) or structured (parsed JSON probes) */
  format?: "raw" | "structured"
}

interface ParsedProbe {
  timestamp: number
  time: string
  probe: string
  session: string
  data: unknown
}

export const readCaptureTool = tool({
  description:
    "Read and filter captured debug output from probe sessions. " +
    "Works with both HTTP captures (structured JSON from browser/CLI probes) and " +
    "shell captures (stdout/stderr from run-and-capture).\n\n" +
    "Use format='structured' to get parsed probe data with timestamps, probe names, and values. " +
    "Use format='raw' for the original text output.",
  args: {
    sessionId: tool.schema
      .string()
      .describe("Session ID, or 'latest' to read the most recent capture"),
    keyword: tool.schema
      .string()
      .optional()
      .describe("Filter lines containing this keyword (case-insensitive)"),
    pattern: tool.schema
      .string()
      .optional()
      .describe("Filter lines matching this regex pattern"),
    afterLine: tool.schema
      .number()
      .optional()
      .describe("Only show lines after this line number (1-indexed)"),
    beforeLine: tool.schema
      .number()
      .optional()
      .describe("Only show lines before this line number"),
    maxLines: tool.schema
      .number()
      .optional()
      .describe("Maximum number of matching lines to return (default: 200)"),
    format: tool.schema
      .enum(["raw", "structured"])
      .optional()
      .describe("Output format: 'raw' (original text) or 'structured' (parsed JSON probes, default)"),
  },
  async execute(args: ReadCaptureArgs, _context: ToolContext): Promise<string> {
    let targetSession = args.sessionId
    const outputFormat = args.format ?? "structured"

    if (targetSession === "latest") {
      if (!existsSync(CAPTURE_DIR)) {
        return "No capture directory found. Run debug-server start and inject probes first."
      }
      const files = readdirSync(CAPTURE_DIR)
        .filter(f => f.endsWith(".log"))
        .map(f => ({
          name: f,
          session: f.replace(".log", ""),
          mtime: statOrNull(join(CAPTURE_DIR, f))?.mtimeMs ?? 0,
        }))
        .sort((a, b) => b.mtime - a.mtime)

      if (files.length === 0) {
        return "No capture files found. Run probes first."
      }
      targetSession = files[0].session
    }

    const capturePath = join(CAPTURE_DIR, `${targetSession}.log`)
    if (!existsSync(capturePath)) {
      return `Capture file not found: ${capturePath}\nAvailable sessions: ${listSessions()}`
    }

    const content = readFileSync(capturePath, "utf-8")

    // Try structured parsing first
    if (outputFormat === "structured") {
      return parseStructured(content, args)
    }

    // Raw text mode (original behavior)
    return parseRaw(content, args, targetSession)
  },
})

function parseStructured(content: string, args: ReadCaptureArgs): string {
  const lines = content.split("\n")
  const parsed: ParsedProbe[] = []
  const headerLines: string[] = []

  for (const line of lines) {
    // Skip header lines
    if (line.startsWith("===") || line.startsWith("Session:") || line.startsWith("Started:") || !line.trim()) {
      headerLines.push(line)
      continue
    }

    // Try to parse as JSON probe
    try {
      const obj = JSON.parse(line)
      if (obj.t !== undefined && obj.p !== undefined) {
        parsed.push({
          timestamp: obj.t,
          time: new Date(obj.t).toISOString(),
          probe: obj.p,
          session: obj.s || "unknown",
          data: obj.d,
        })
        continue
      }
    } catch {
      // Not JSON — treat as raw text line
    }

    // Also handle [DEBUG] stdout lines
    const debugMatch = line.match(/\[DEBUG\]\s*(.+)/)
    if (debugMatch) {
      try {
        const obj = JSON.parse(debugMatch[1])
        parsed.push({
          timestamp: obj.t,
          time: new Date(obj.t).toISOString(),
          probe: obj.p,
          session: obj.s || "unknown",
          data: obj.d,
        })
      } catch {
        // Not parseable, skip
      }
    }
  }

  // Apply filters
  let filtered = parsed

  if (args.keyword) {
    const kw = args.keyword.toLowerCase()
    filtered = filtered.filter(p =>
      p.probe.toLowerCase().includes(kw) ||
      JSON.stringify(p.data).toLowerCase().includes(kw) ||
      p.session.toLowerCase().includes(kw)
    )
  }

  if (args.pattern) {
    try {
      const regex = new RegExp(args.pattern, "i")
      filtered = filtered.filter(p =>
        regex.test(p.probe) ||
        regex.test(JSON.stringify(p.data))
      )
    } catch {
      return `Invalid regex pattern: ${args.pattern}`
    }
  }

  // Apply line range
  if (args.afterLine && args.afterLine > 1) {
    filtered = filtered.slice(args.afterLine - 1)
  }
  if (args.beforeLine && args.beforeLine > 0) {
    filtered = filtered.slice(-args.beforeLine)
  }

  const maxLines = args.maxLines ?? 200
  const truncated = filtered.length > maxLines
  const result = filtered.slice(0, maxLines)

  // Format output
  const entries = result.map((p, i) => {
    const idx = String(i + 1).padStart(3)
    const dataStr = typeof p.data === "object" ? JSON.stringify(p.data) : String(p.data)
    return `${idx} | ${p.time} | ${p.probe} | ${dataStr}`
  }).join("\n")

  const header = `Session probes: ${parsed.length} total | ${filtered.length} matching${truncated ? ` (showing ${maxLines})` : ""}\n${"─".repeat(80)}`

  if (parsed.length === 0) {
    return "No structured probe data found. The capture may contain only raw text output. Try format='raw'."
  }

  return `${header}\n${entries}`
}

function parseRaw(content: string, args: ReadCaptureArgs, session: string): string {
  let lines = content.split("\n")

  if (args.afterLine && args.afterLine > 0) {
    lines = lines.slice(args.afterLine - 1)
  }
  if (args.beforeLine && args.beforeLine > 0) {
    const start = Math.max(0, lines.length - args.beforeLine)
    lines = lines.slice(start)
  }

  let filtered = lines
  const maxLines = args.maxLines ?? 200
  let regex: RegExp | null = null

  if (args.pattern) {
    try {
      regex = new RegExp(args.pattern, "i")
    } catch {
      return `Invalid regex pattern: ${args.pattern}`
    }
  }

  if (args.keyword || regex) {
    const keyword = args.keyword?.toLowerCase()
    filtered = lines.filter((line) => {
      if (keyword && !line.toLowerCase().includes(keyword)) return false
      if (regex && !regex.test(line)) return false
      return true
    })
  }

  const truncated = filtered.length > maxLines
  const result = filtered.slice(0, maxLines)

  const startLine = (args.afterLine ?? 1)
  const numbered = result.map((line, i) => {
    const lineNum = startLine + i
    return `${String(lineNum).padStart(5)} | ${line}`
  }).join("\n")

  const header = `Session: ${session}\nTotal lines: ${lines.length} | Filtered: ${filtered.length}${truncated ? ` (showing first ${maxLines})` : ""}\n---`
  return `${header}\n${numbered}`
}

function statOrNull(path: string) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

function listSessions(): string {
  if (!existsSync(CAPTURE_DIR)) return "(none)"
  return readdirSync(CAPTURE_DIR)
    .filter(f => f.endsWith(".log"))
    .map(f => f.replace(".log", ""))
    .join(", ")
}
