import { type Plugin as V1Plugin } from "@opencode-ai/plugin"
import { Plugin } from "@opencode/plugin"
import { z } from "zod"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { readFileSync } from "node:fs"

import { runAndCaptureTool } from "./tools/run-and-capture"
import { readCaptureTool } from "./tools/read-capture"
import { instrumentTool } from "./tools/instrument"
import { cleanupTool } from "./tools/cleanup"
import { quickCheckTool } from "./tools/quick-check"
import { debugServerTool } from "./tools/debug-server"

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
 * - debug-instrument: Inject debug probes into source files (CLI or browser mode)
 * - debug-run-and-capture: Run commands and capture stdout/stderr to log files
 * - debug-read-capture: Read and filter captured debug output
 * - debug-cleanup: Remove debug probes and clean up capture logs
 * - debug-server: Manage HTTP capture server for browser mode probes
 *
 * Supports both OpenCode V2 (default export with `id`/`setup`) and OpenCode 1.x
 * >= 1.18.29 (default export with `server()`) from the same entrypoint.
 */

// ─── V1 implementation (OpenCode 1.x) ─────────────────────────────────

const DebugPlugin: V1Plugin = async (_ctx) => {
  return {
    config: async (config: Record<string, unknown>) => {
      // Register the debug agent — deep-merge so user overrides (model, temperature, etc.) survive
      const existingDebug = (config.agent as Record<string, Record<string, unknown>>)?.debug
      config.agent = {
        ...(config.agent as Record<string, unknown> ?? {}),
        debug: {
          name: "debug",
          prompt: AGENT_DIR,
          ...existingDebug,
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
      "debug-server": debugServerTool,
      "debug-instrument": instrumentTool,
      "debug-run-and-capture": runAndCaptureTool,
      "debug-read-capture": readCaptureTool,
      "debug-cleanup": cleanupTool,
    },
  }
}

// ─── V2 implementation (OpenCode 2) ───────────────────────────────────

interface V1Tool {
  description: string
  args: Record<string, any>
  execute: (args: any, context: any) => Promise<string>
}

/**
 * Convert a V1 tool definition (built with the `tool()` helper, zod args,
 * string return) into a V2 `Tool.Info` registration (JSON Schema input,
 * structured content result). The V1 execute logic is reused as-is.
 */
function toV2Tool(name: string, v1: V1Tool) {
  return {
    name,
    description: v1.description,
    // Zod v4 generates the JSON Schema (descriptions, enums, optionality) for us
    input: z.toJSONSchema(z.object(v1.args)),
    async execute(input: unknown, context: unknown) {
      const text = await v1.execute(input, context)
      return { content: text }
    },
  } as any
}

const DebugPluginV2 = Plugin.define({
  id: "opencode-debug",
  async setup(ctx) {
    // Expose the bundled debug skill. V2 skills are registered through a
    // transform instead of the V1 `config.skills.paths` mutation.
    const skillPath = join(SKILL_DIR, "SKILL.md")
    const skillContent = readFileSync(skillPath, "utf-8")
    await ctx.skill.transform((editor) => {
      editor.add({
        id: "debug",
        name: "Debug",
        description:
          "Runtime debugging workflow. Activates when the user reports a bug, error, crash, or unexpected behavior.",
        path: skillPath,
        content: skillContent,
        autoinvoke: true,
      } as any)
    })

    // Register the debug tools. V2 tools are registered through a tool
    // transform instead of the V1 returned `tool` map.
    await ctx.tool.transform((editor) => {
      editor.add(toV2Tool("debug-quick-check", quickCheckTool as V1Tool))
      editor.add(toV2Tool("debug-server", debugServerTool as V1Tool))
      editor.add(toV2Tool("debug-instrument", instrumentTool as V1Tool))
      editor.add(toV2Tool("debug-run-and-capture", runAndCaptureTool as V1Tool))
      editor.add(toV2Tool("debug-read-capture", readCaptureTool as V1Tool))
      editor.add(toV2Tool("debug-cleanup", cleanupTool as V1Tool))
    })
  },
})

// ─── Entrypoint ───────────────────────────────────────────────────────
// V2 reads `id` + `setup`; V1 (>= 1.18.29) reads `server()`.
// See https://opencode.ai/v2/docs/build/plugins/migrate-v1#support-v1-and-v2-from-one-package

export default {
  ...DebugPluginV2,
  server: async () => DebugPlugin({} as any),
}
