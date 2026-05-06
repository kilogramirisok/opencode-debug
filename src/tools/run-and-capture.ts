/**
 * Run a shell command and capture stdout/stderr to a log file.
 * Returns exit code, duration, and a preview of the output.
 */
import { tool, type ToolContext } from "@opencode-ai/plugin"
import { spawn } from "node:child_process"
import { mkdirSync, appendFileSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

const CAPTURE_DIR = join(process.env.RUNTIME_DIR ?? "/tmp", "opencode-debug")

function ensureCaptureDir() {
  if (!existsSync(CAPTURE_DIR)) {
    mkdirSync(CAPTURE_DIR, { recursive: true })
  }
}

export interface RunAndCaptureArgs {
  /** Shell command to execute */
  command: string
  /** Timeout in seconds (default: 60) */
  timeout?: number
  /** Working directory for the command */
  cwd?: string
  /** Additional environment variables (KEY=VALUE format) */
  env?: Record<string, string>
  /** Reuse an existing session ID (for appending to a capture file) */
  sessionId?: string
}

export interface RunAndCaptureResult {
  sessionId: string
  exitCode: number
  durationMs: number
  totalLines: number
  /** Last N lines of combined output */
  preview: string
  /** Path to the full capture log */
  capturePath: string
  /** Whether the command timed out */
  timedOut: boolean
}

export const runAndCaptureTool = tool({
  description:
    "Run a shell command and capture all stdout/stderr to a log file for later analysis. " +
    "Use this to reproduce bugs and capture runtime output. Returns a session ID you can use " +
    "with read-capture to analyze the output and with run-and-capture again to append more runs.",
  args: {
    command: tool.schema
      .string()
      .describe("Shell command to execute (e.g., 'npm test', 'node server.js', 'curl localhost:3000/api')"),
    timeout: tool.schema
      .number()
      .optional()
      .describe("Timeout in seconds (default: 60)"),
    cwd: tool.schema
      .string()
      .optional()
      .describe("Working directory for the command"),
    env: tool.schema
      .record(tool.schema.string(), tool.schema.string())
      .optional()
      .describe("Additional environment variables"),
    sessionId: tool.schema
      .string()
      .optional()
      .describe("Reuse an existing session ID to append to its capture file"),
  },
  async execute(args: RunAndCaptureArgs, _context: ToolContext): Promise<string> {
    ensureCaptureDir()

    const sessionId = args.sessionId ?? randomUUID().slice(0, 8)
    const capturePath = join(CAPTURE_DIR, `${sessionId}.log`)
    const timeoutSec = args.timeout ?? 60
    const workDir = args.cwd ?? process.cwd()

    // Write a header if new file
    if (!existsSync(capturePath)) {
      writeFileSync(capturePath, `=== opencode-debug capture ===\nSession: ${sessionId}\nCommand: ${args.command}\nCWD: ${workDir}\nStarted: ${new Date().toISOString()}\n===\n\n`)
    } else {
      appendFileSync(capturePath, `\n=== run at ${new Date().toISOString()} ===\nCommand: ${args.command}\n---\n`)
    }

    return new Promise((resolve) => {
      const startTime = Date.now()
      let output = ""
      let totalLines = 0

      const proc = spawn("bash", ["-c", args.command], {
        cwd: workDir,
        env: {
          ...process.env,
          ...(args.env ?? {}),
          DEBUG_SESSION_ID: sessionId,
          FORCE_COLOR: "0",
          NO_COLOR: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      })

      const timer = setTimeout(() => {
        proc.kill("SIGTERM")
        setTimeout(() => proc.kill("SIGKILL"), 3000)
      }, timeoutSec * 1000)

      const onChunk = (chunk: Buffer, stream: "stdout" | "stderr") => {
        const text = chunk.toString()
        output += text
        const lines = text.split("\n").length - 1
        totalLines += lines
        // Append to capture file in real-time
        const prefix = stream === "stderr" ? "[ERR] " : ""
        appendFileSync(capturePath, prefix + text)
      }

      proc.stdout?.on("data", (chunk: Buffer) => onChunk(chunk, "stdout"))
      proc.stderr?.on("data", (chunk: Buffer) => onChunk(chunk, "stderr"))

      proc.on("close", (code) => {
        clearTimeout(timer)
        const durationMs = Date.now() - startTime
        const timedOut = durationMs >= timeoutSec * 1000 - 100

        // Get last 80 lines for preview
        const lines = output.split("\n")
        const previewLines = lines.slice(-80)
        const preview = previewLines.join("\n").trim()

        appendFileSync(capturePath, `\n---\nExit: ${code ?? "unknown"} | Duration: ${durationMs}ms | Lines: ${totalLines}${timedOut ? " (TIMED OUT)" : ""}\n\n`)

        const result: RunAndCaptureResult = {
          sessionId,
          exitCode: code ?? -1,
          durationMs,
          totalLines,
          preview,
          capturePath,
          timedOut,
        }

        resolve(JSON.stringify(result, null, 2))
      })

      proc.on("error", (err) => {
        clearTimeout(timer)
        const durationMs = Date.now() - startTime
        resolve(JSON.stringify({
          sessionId,
          exitCode: -1,
          durationMs,
          totalLines: 0,
          preview: `Process error: ${err.message}`,
          capturePath,
          timedOut: false,
        } satisfies RunAndCaptureResult, null, 2))
      })
    })
  },
})
