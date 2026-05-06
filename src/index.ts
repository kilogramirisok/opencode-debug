import { type Plugin } from "@opencode-ai/plugin"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { runAndCaptureTool } from "./tools/run-and-capture"
import { readCaptureTool } from "./tools/read-capture"
import { instrumentTool } from "./tools/instrument"
import { cleanupTool } from "./tools/cleanup"
import { quickCheckTool } from "./tools/quick-check"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PLUGIN_ROOT = join(__dirname, "..")
const AGENT_DIR = join(PLUGIN_ROOT, "agent")
const SKILL_DIR = join(PLUGIN_ROOT, "skill")

/**
 * OpenCode Debug Agent Plugin
 * 
 * Provides runtime debugging tools for OpenCode:
 * - debug-quick-check: Fast triage — run a command and diagnose failures
 * - debug-instrument: Inject debug probes into source files
 * - debug-run-and-capture: Run commands and capture stdout/stderr to log files
 * - debug-read-capture: Read and filter captured debug output
 * - debug-cleanup: Remove debug probes and clean up capture logs
 */
const DebugPlugin: Plugin = async (_ctx) => {
  return {
    config: async (config: Record<string, unknown>) => {
      // Register the debug agent
      config.agent = {
        ...(config.agent as Record<string, unknown> ?? {}),
        debug: {
          name: "debug",
          prompt: AGENT_DIR,
        },
      }

      // Expose bundled skills
      config.skills = {
        ...((config.skills as Record<string, unknown>) ?? {}),
        paths: [
          ...(((config.skills as { paths?: string[] })?.paths) ?? []),
          SKILL_DIR,
        ],
      }
    },

    tool: {
      "debug-quick-check": quickCheckTool,
      "debug-instrument": instrumentTool,
      "debug-run-and-capture": runAndCaptureTool,
      "debug-read-capture": readCaptureTool,
      "debug-cleanup": cleanupTool,
    },
  }
}

export default DebugPlugin
