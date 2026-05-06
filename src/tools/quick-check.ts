/**
 * Quick health check — run a command, check if it fails, and return a compact diagnosis.
 * A simpler alternative to the full instrument→run→analyze workflow for fast triage.
 */
import { tool, type ToolContext } from "@opencode-ai/plugin"
import { spawn } from "node:child_process"

export interface QuickCheckArgs {
  /** Command to run */
  command: string
  /** Working directory */
  cwd?: string
  /** Timeout in seconds */
  timeout?: number
}

export const quickCheckTool = tool({
  description:
    "Run a command and quickly diagnose failures. Returns exit code, error output, " +
    "and a summary of what went wrong. Use this for fast triage before deciding whether " +
    "to use the full debug workflow (instrument → run-and-capture → read-capture → fix → cleanup).",
  args: {
    command: tool.schema
      .string()
      .describe("Command to run (e.g., 'npm test', 'cargo build', 'python main.py')"),
    cwd: tool.schema
      .string()
      .optional()
      .describe("Working directory"),
    timeout: tool.schema
      .number()
      .optional()
      .describe("Timeout in seconds (default: 30)"),
  },
  async execute(args: QuickCheckArgs, _context: ToolContext): Promise<string> {
    const workDir = args.cwd ?? process.cwd()
    const timeoutSec = args.timeout ?? 30

    return new Promise((resolve) => {
      const startTime = Date.now()
      let stdout = ""
      let stderr = ""

      const proc = spawn("bash", ["-c", args.command], {
        cwd: workDir,
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      })

      const timer = setTimeout(() => {
        proc.kill("SIGKILL")
      }, timeoutSec * 1000)

      proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString() })
      proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString() })

      proc.on("close", (code) => {
        clearTimeout(timer)
        const durationMs = Date.now() - startTime
        const success = code === 0

        // Extract key error information
        const errorLines = stderr.split("\n").filter(l => l.trim())
        const lastErrors = errorLines.slice(-10).join("\n")

        // Look for common patterns
        const patterns: Record<string, string[]> = {
          "Type Error": ["TypeError", "is not a function", "cannot read propert", "undefined is not"],
          "Reference Error": ["ReferenceError", "is not defined"],
          "Syntax Error": ["SyntaxError", "Unexpected token", "parse error"],
          "Import Error": ["Cannot find module", "Module not found", "ImportError", "ModuleNotFoundError"],
          "Test Failure": ["FAIL", "AssertionError", "expected", "Assertion failed"],
          "Build Error": ["error TS", "compilation error", "cargo error", "error:"],
          "Connection Error": ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "Connection refused", "network error"],
          "Permission Error": ["EACCES", "Permission denied", "permission denied"],
          "OOM": ["ENOMEM", "out of memory", "heap out of memory", "Cannot allocate memory"],
          "Port In Use": ["EADDRINUSE", "address already in use"],
        }

        const detected: string[] = []
        const allOutput = (stdout + stderr).toLowerCase()
        for (const [category, keywords] of Object.entries(patterns)) {
          if (keywords.some(kw => allOutput.includes(kw.toLowerCase()))) {
            detected.push(category)
          }
        }

        const result = {
          command: args.command,
          exitCode: code ?? -1,
          durationMs,
          success,
          detectedIssues: detected.length > 0 ? detected : undefined,
          stderr: lastErrors || undefined,
          stdout: success ? stdout.slice(-500).trim() || undefined : undefined,
        }

        resolve(JSON.stringify(result, null, 2))
      })

      proc.on("error", (err) => {
        clearTimeout(timer)
        resolve(JSON.stringify({
          command: args.command,
          exitCode: -1,
          durationMs: Date.now() - startTime,
          success: false,
          detectedIssues: ["Process Error"],
          stderr: err.message,
        }, null, 2))
      })
    })
  },
})
