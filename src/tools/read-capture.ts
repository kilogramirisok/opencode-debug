/**
 * Read and filter captured debug output.
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
}

export const readCaptureTool = tool({
  description:
    "Read and filter captured debug output from a previous run-and-capture session. " +
    "Use this to analyze runtime logs, find error messages, trace execution flow, " +
    "and identify the root cause of bugs. Supports keyword search, regex filtering, and line ranges.",
  args: {
    sessionId: tool.schema
      .string()
      .describe("Session ID from run-and-capture, or 'latest' to read the most recent capture"),
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
  },
  async execute(args: ReadCaptureArgs, _context: ToolContext): Promise<string> {
    let targetSession = args.sessionId

    if (targetSession === "latest") {
      // Find the most recent capture file
      if (!existsSync(CAPTURE_DIR)) {
        return "No capture directory found. Run run-and-capture first."
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
        return "No capture files found. Run run-and-capture first."
      }
      targetSession = files[0].session
    }

    const capturePath = join(CAPTURE_DIR, `${targetSession}.log`)
    if (!existsSync(capturePath)) {
      return `Capture file not found: ${capturePath}\nAvailable sessions: ${listSessions()}`
    }

    const content = readFileSync(capturePath, "utf-8")
    let lines = content.split("\n")

    // Apply line range filter
    if (args.afterLine && args.afterLine > 0) {
      lines = lines.slice(args.afterLine - 1)
    }
    if (args.beforeLine && args.beforeLine > 0) {
      const start = Math.max(0, lines.length - args.beforeLine)
      lines = lines.slice(start)
    }

    // Apply keyword/regex filter
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

    // Add line numbers
    const startLine = (args.afterLine ?? 1)
    const numbered = result.map((line, i) => {
      const lineNum = startLine + i
      return `${String(lineNum).padStart(5)} | ${line}`
    }).join("\n")

    const header = `Session: ${targetSession}\nTotal lines: ${lines.length} | Filtered: ${filtered.length}${truncated ? ` (showing first ${maxLines})` : ""}\n---`
    return `${header}\n${numbered}`
  },
})

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
