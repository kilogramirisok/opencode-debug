/**
 * Remove debug probes and restore files.
 * Uses @debug markers to find and remove injected lines.
 * Also restores from .bak files as a safety net.
 */
import { tool, type ToolContext } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, statSync } from "node:fs"
import { join, basename } from "node:path"

const CAPTURE_DIR = join(process.env.RUNTIME_DIR ?? "/tmp", "opencode-debug")

export interface CleanupArgs {
  /** Session ID to clean up (removes probes with this session marker) */
  sessionId?: string
  /** Specific file to clean up (if not set, cleans all instrumented files from manifest) */
  filePath?: string
  /** Also remove capture log files */
  removeLogs?: boolean
  /** Restore from .bak files instead of removing markers (more aggressive restore) */
  restoreFromBackup?: boolean
  /** Dry run: show what would be cleaned without doing it */
  dryRun?: boolean
}

interface CleanupAction {
  file: string
  action: "removed-markers" | "restored-backup" | "removed-log"
  details: string
}

export const cleanupTool = tool({
  description:
    "Remove debug probes from source files and optionally clean up capture logs. " +
    "Finds all /* @debug:... */ and # @debug:... markers and removes them. " +
    "Can target a specific session ID or clean everything. " +
    "Supports dry-run mode to preview changes. " +
    "ALWAYS run this after debugging is complete to leave the codebase clean.",
  args: {
    sessionId: tool.schema
      .string()
      .optional()
      .describe("Session ID to clean up. Removes only probes from this session."),
    filePath: tool.schema
      .string()
      .optional()
      .describe("Specific file to clean (otherwise uses manifest to find all instrumented files)"),
    removeLogs: tool.schema
      .boolean()
      .optional()
      .describe("Also remove capture log files (default: false)"),
    restoreFromBackup: tool.schema
      .boolean()
      .optional()
      .describe("Restore files from .bak backups instead of removing markers (default: false)"),
    dryRun: tool.schema
      .boolean()
      .optional()
      .describe("Preview what would be cleaned without making changes"),
  },
  async execute(args: CleanupArgs, _context: ToolContext): Promise<string> {
    const actions: CleanupAction[] = []

    // 1. Collect files to clean
    const filesToClean = new Set<string>()

    if (args.filePath) {
      filesToClean.add(args.filePath)
    }

    // Read manifest for session files
    if (args.sessionId) {
      const manifestPath = join(CAPTURE_DIR, `${args.sessionId}.manifest`)
      if (existsSync(manifestPath)) {
        const manifest = readFileSync(manifestPath, "utf-8")
        const fileMatches = manifest.matchAll(/\| (.+):\d+ \|/g)
        for (const match of fileMatches) {
          filesToClean.add(match[1].trim())
        }
      }
    }

    // If no files specified and no session, find all .bak files
    if (filesToClean.size === 0) {
      const findBaks = (dir: string) => {
        // Simple recursive .bak finder
        try {
          const entries = readdirSync(dir, { withFileTypes: true })
          for (const entry of entries) {
            if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue
            const full = join(dir, entry.name)
            if (entry.isDirectory()) {
              findBaks(full)
            } else if (entry.name.endsWith(".debug.bak")) {
              filesToClean.add(full.replace(".debug.bak", ""))
            }
          }
        } catch { /* skip */ }
      }
      findBaks(process.cwd())
    }

    // 2. Clean each file
    for (const filePath of filesToClean) {
      if (!existsSync(filePath)) continue

      if (args.restoreFromBackup) {
        const bakPath = filePath + ".debug.bak"
        if (existsSync(bakPath)) {
          if (!args.dryRun) {
            const backup = readFileSync(bakPath, "utf-8")
            writeFileSync(filePath, backup)
            unlinkSync(bakPath)
          }
          actions.push({ file: filePath, action: "restored-backup", details: `Restored from ${basename(bakPath)}` })
        }
      } else {
        // Remove probe lines by markers
        const content = readFileSync(filePath, "utf-8")
        const lines = content.split("\n")
        const sessionPattern = args.sessionId ?? ""

        const cleanedLines: string[] = []
        let skipNext = false

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]

          // Check if this is a marker line
          const isMarker = line.match(/\/\*\s*@debug:\w+:[\w-]+\s*\*\//) || line.match(/#\s*@debug:\w+:[\w-]+/)
          if (isMarker) {
            // If sessionId specified, only remove markers for that session
            if (sessionPattern && !line.includes(sessionPattern)) {
              cleanedLines.push(line)
              continue
            }
            // Skip the marker line and the next line (probe code)
            skipNext = true
            actions.push({ file: filePath, action: "removed-markers", details: `Line ${i + 1}: ${line.trim()}` })
            continue
          }

          // Skip the line right after a removed marker
          if (skipNext) {
            skipNext = false
            continue
          }

          cleanedLines.push(line)
        }

        if (cleanedLines.length !== lines.length) {
          if (!args.dryRun) {
            writeFileSync(filePath, cleanedLines.join("\n"))
            // Remove backup if exists
            const bakPath = filePath + ".debug.bak"
            if (existsSync(bakPath)) unlinkSync(bakPath)
          }
        }
      }
    }

    // 3. Optionally remove log files
    if (args.removeLogs && args.sessionId) {
      const logPath = join(CAPTURE_DIR, `${args.sessionId}.log`)
      const manifestPath = join(CAPTURE_DIR, `${args.sessionId}.manifest`)

      for (const p of [logPath, manifestPath]) {
        if (existsSync(p)) {
          if (!args.dryRun) unlinkSync(p)
          actions.push({ file: p, action: "removed-log", details: `Removed ${basename(p)}` })
        }
      }
    }

    // 4. Remove all logs if no session specified
    if (args.removeLogs && !args.sessionId && existsSync(CAPTURE_DIR)) {
      const files = readdirSync(CAPTURE_DIR).filter(f => f.endsWith(".log") || f.endsWith(".manifest"))
      for (const f of files) {
        const p = join(CAPTURE_DIR, f)
        if (!args.dryRun) unlinkSync(p)
        actions.push({ file: p, action: "removed-log", details: `Removed ${f}` })
      }
    }

    const summary = args.dryRun ? "DRY RUN — no changes made" : "Cleanup complete"
    const actionLog = actions.length > 0
      ? actions.map(a => `  [${a.action}] ${a.file}: ${a.details}`).join("\n")
      : "  (nothing to clean)"

    return `${summary}\nActions:\n${actionLog}`
  },
})
