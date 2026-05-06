import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest"
import { spawn } from "node:child_process"
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs"
import { join } from "node:path"

const CAPTURE_DIR = join(process.env.RUNTIME_DIR ?? "/tmp", "opencode-debug")
const TEST_DIR = "/tmp/debug-test-project"

// Helper to run a command and capture output
function run(cmd: string, cwd?: string, timeout = 10000): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn("bash", ["-c", cmd], {
      cwd: cwd ?? process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    })
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeout)
    let stdout = ""
    let stderr = ""
    proc.stdout?.on("data", (c: Buffer) => (stdout += c.toString()))
    proc.stderr?.on("data", (c: Buffer) => (stderr += c.toString()))
    proc.on("close", (code) => {
      clearTimeout(timer)
      resolve({ exitCode: code ?? -1, stdout, stderr })
    })
    proc.on("error", (err) => {
      clearTimeout(timer)
      resolve({ exitCode: -1, stdout, stderr: err.message })
    })
  })
}

describe("Plugin Build", () => {
  it("compiles TypeScript without errors", async () => {
    const result = await run("npx tsc --noEmit", "/home/rom/Developer/opencode-debug")
    expect(result.exitCode).toBe(0)
  })

  it("builds dist/ output", async () => {
    const result = await run("npx tsc", "/home/rom/Developer/opencode-debug")
    expect(result.exitCode).toBe(0)
    expect(existsSync("/home/rom/Developer/opencode-debug/dist/index.js")).toBe(true)
    expect(existsSync("/home/rom/Developer/opencode-debug/dist/tools/run-and-capture.js")).toBe(true)
    expect(existsSync("/home/rom/Developer/opencode-debug/dist/tools/instrument.js")).toBe(true)
    expect(existsSync("/home/rom/Developer/opencode-debug/dist/tools/read-capture.js")).toBe(true)
    expect(existsSync("/home/rom/Developer/opencode-debug/dist/tools/cleanup.js")).toBe(true)
    expect(existsSync("/home/rom/Developer/opencode-debug/dist/tools/quick-check.js")).toBe(true)
  })
})

describe("Tool: run-and-capture", () => {
  it("captures stdout and stderr to a log file", async () => {
    // Import the built tool
    const { runAndCaptureTool } = await import("../dist/tools/run-and-capture.js")

    const result = await runAndCaptureTool.execute(
      {
        command: 'echo "hello world" && echo "error msg" >&2',
        timeout: 5,
        cwd: "/tmp",
      },
      {
        sessionID: "test-session",
        messageID: "test-msg",
        agent: "test",
        directory: "/tmp",
        worktree: "/tmp",
        abort: new AbortController().signal,
        metadata: () => {},
        ask: () => ({}) as any,
      }
    )

    const parsed = JSON.parse(result as string)
    expect(parsed.exitCode).toBe(0)
    expect(parsed.preview).toContain("hello world")
    expect(parsed.sessionId).toBeTruthy()
    expect(parsed.capturePath).toContain("opencode-debug")
    expect(parsed.timedOut).toBe(false)
  })

  it("captures non-zero exit codes", async () => {
    const { runAndCaptureTool } = await import("../dist/tools/run-and-capture.js")

    const result = await runAndCaptureTool.execute(
      { command: "exit 42", timeout: 5, cwd: "/tmp" },
      {
        sessionID: "test-session",
        messageID: "test-msg",
        agent: "test",
        directory: "/tmp",
        worktree: "/tmp",
        abort: new AbortController().signal,
        metadata: () => {},
        ask: () => ({}) as any,
      }
    )

    const parsed = JSON.parse(result as string)
    expect(parsed.exitCode).toBe(42)
  })

  it("appends to existing session on reuse", async () => {
    const { runAndCaptureTool } = await import("../dist/tools/run-and-capture.js")

    const ctx = {
      sessionID: "test-session",
      messageID: "test-msg",
      agent: "test",
      directory: "/tmp",
      worktree: "/tmp",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: () => ({}) as any,
    }

    // First run
    await runAndCaptureTool.execute({ command: 'echo "first run"', sessionId: "reuse-test", cwd: "/tmp", timeout: 5 }, ctx)

    // Second run (reuse session)
    const result = await runAndCaptureTool.execute({ command: 'echo "second run"', sessionId: "reuse-test", cwd: "/tmp", timeout: 5 }, ctx)
    const parsed = JSON.parse(result as string)
    expect(parsed.sessionId).toBe("reuse-test")

    // Verify capture file has both runs
    const captureContent = readFileSync(parsed.capturePath, "utf-8")
    expect(captureContent).toContain("first run")
    expect(captureContent).toContain("second run")
  })
})

describe("Tool: quick-check", () => {
  it("detects common error patterns", async () => {
    const { quickCheckTool } = await import("../dist/tools/quick-check.js")

    const result = await quickCheckTool.execute(
      {
        command: 'node -e "const x = undefined; console.log(x.name)"',
        timeout: 5,
        cwd: "/tmp",
      },
      {
        sessionID: "test-session",
        messageID: "test-msg",
        agent: "test",
        directory: "/tmp",
        worktree: "/tmp",
        abort: new AbortController().signal,
        metadata: () => {},
        ask: () => ({}) as any,
      }
    )

    const parsed = JSON.parse(result as string)
    expect(parsed.success).toBe(false)
    expect(parsed.detectedIssues).toBeDefined()
    expect(parsed.detectedIssues).toContain("Type Error")
  })

  it("reports success for passing commands", async () => {
    const { quickCheckTool } = await import("../dist/tools/quick-check.js")

    const result = await quickCheckTool.execute(
      { command: 'echo "all good"', timeout: 5, cwd: "/tmp" },
      {
        sessionID: "test-session",
        messageID: "test-msg",
        agent: "test",
        directory: "/tmp",
        worktree: "/tmp",
        abort: new AbortController().signal,
        metadata: () => {},
        ask: () => ({}) as any,
      }
    )

    const parsed = JSON.parse(result as string)
    expect(parsed.success).toBe(true)
    expect(parsed.exitCode).toBe(0)
  })
})

describe("Tool: instrument", () => {
  const testFile = join(TEST_DIR, "target.ts")

  beforeAll(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true })
    writeFileSync(testFile, `function greet(name: string) {\n  return "Hello " + name\n}\nconsole.log(greet("world"))\n`)
  })

  afterAll(() => {
    if (existsSync(testFile)) rmSync(testFile)
    if (existsSync(testFile + ".debug.bak")) rmSync(testFile + ".debug.bak")
  })

  it("injects a log probe into a TypeScript file", async () => {
    const { instrumentTool } = await import("../dist/tools/instrument.js")

    const result = await instrumentTool.execute(
      {
        filePath: testFile,
        probeType: "log",
        lineNumber: 2,
        expression: '"name=" + name',
        sessionId: "test-inst",
        label: "greet-log",
      },
      {
        sessionID: "test-session",
        messageID: "test-msg",
        agent: "test",
        directory: TEST_DIR,
        worktree: TEST_DIR,
        abort: new AbortController().signal,
        metadata: () => {},
        ask: () => ({}) as any,
      }
    )

    const parsed = JSON.parse(result as string)
    expect(parsed.success).toBe(true)
    expect(parsed.probeType).toBe("log")
    expect(existsSync(testFile + ".debug.bak")).toBe(true)

    // Verify the file now contains the probe
    const content = readFileSync(testFile, "utf-8")
    expect(content).toContain("@debug:log:test-inst")
    expect(content).toContain("console.log")
  })

  it("creates a manifest entry", async () => {
    const manifestPath = join(CAPTURE_DIR, "test-inst.manifest")
    expect(existsSync(manifestPath)).toBe(true)
    const content = readFileSync(manifestPath, "utf-8")
    expect(content).toContain("target.ts")
    expect(content).toContain("log")
  })
})

describe("Tool: read-capture", () => {
  it("reads a capture file by session ID", async () => {
    const { readCaptureTool } = await import("../dist/tools/read-capture.js")

    // First create a capture
    const { runAndCaptureTool } = await import("../dist/tools/run-and-capture.js")
    const ctx = {
      sessionID: "test-session",
      messageID: "test-msg",
      agent: "test",
      directory: "/tmp",
      worktree: "/tmp",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: () => ({}) as any,
    }
    await runAndCaptureTool.execute({ command: 'echo "line1\nline2\nline3\nERROR: something broke\nline5"', sessionId: "read-test", cwd: "/tmp", timeout: 5 }, ctx)

    // Read with keyword filter
    const result = await readCaptureTool.execute({ sessionId: "read-test", keyword: "ERROR" }, ctx)
    expect(result).toContain("something broke")
  })

  it("supports regex filtering", async () => {
    const { readCaptureTool } = await import("../dist/tools/read-capture.js")

    const ctx = {
      sessionID: "test-session",
      messageID: "test-msg",
      agent: "test",
      directory: "/tmp",
      worktree: "/tmp",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: () => ({}) as any,
    }

    const result = await readCaptureTool.execute({ sessionId: "read-test", pattern: "ERROR.*" }, ctx)
    expect(result).toContain("something broke")
  })

  it("returns helpful error for missing session", async () => {
    const { readCaptureTool } = await import("../dist/tools/read-capture.js")

    const ctx = {
      sessionID: "test-session",
      messageID: "test-msg",
      agent: "test",
      directory: "/tmp",
      worktree: "/tmp",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: () => ({}) as any,
    }

    const result = await readCaptureTool.execute({ sessionId: "nonexistent-xyz" }, ctx)
    expect(result).toContain("not found")
  })
})

describe("Tool: cleanup", () => {
  it("removes debug probes from files", async () => {
    const { instrumentTool } = await import("../dist/tools/instrument.js")
    const { cleanupTool } = await import("../dist/tools/cleanup.js")

    const testFile = join(TEST_DIR, "cleanup-target.ts")
    const original = `function calc(x: number) {\n  return x * 2\n}\n`
    writeFileSync(testFile, original)

    const ctx = {
      sessionID: "test-session",
      messageID: "test-msg",
      agent: "test",
      directory: TEST_DIR,
      worktree: TEST_DIR,
      abort: new AbortController().signal,
      metadata: () => {},
      ask: () => ({}) as any,
    }

    // Inject
    await instrumentTool.execute({
      filePath: testFile,
      probeType: "log",
      lineNumber: 2,
      expression: '"x=" + x',
      sessionId: "cleanup-test",
      label: "calc-log",
    }, ctx)

    // Verify probe is there
    const instrumented = readFileSync(testFile, "utf-8")
    expect(instrumented).toContain("@debug")

    // Cleanup
    const result = await cleanupTool.execute({
      sessionId: "cleanup-test",
      removeLogs: true,
    }, ctx)

    expect(result).toContain("removed-markers")

    // Verify probe is gone
    const cleaned = readFileSync(testFile, "utf-8")
    expect(cleaned).not.toContain("@debug")
    expect(cleaned).not.toContain("debug.bak")
  })
})

describe("Plugin Entry Point", () => {
  it("exports a valid plugin function", async () => {
    const mod = await import("../dist/index.js")
    expect(typeof mod.default).toBe("function")
  })

  it("returns valid hooks when called", async () => {
    const mod = await import("../dist/index.js")
    const hooks = await mod.default({
      client: {} as any,
      project: {} as any,
      directory: "/tmp",
      worktree: "/tmp",
      experimental_workspace: { register: () => {} },
      serverUrl: new URL("http://localhost:3000"),
      $: {} as any,
    })

    expect(hooks).toBeDefined()
    expect(hooks.tool).toBeDefined()
    expect(hooks.config).toBeDefined()

    // Verify all 5 tools are registered
    expect(hooks.tool["debug-quick-check"]).toBeDefined()
    expect(hooks.tool["debug-instrument"]).toBeDefined()
    expect(hooks.tool["debug-run-and-capture"]).toBeDefined()
    expect(hooks.tool["debug-read-capture"]).toBeDefined()
    expect(hooks.tool["debug-cleanup"]).toBeDefined()

    // Each tool should have description, args, and execute
    for (const [name, toolDef] of Object.entries(hooks.tool!)) {
      expect(toolDef.description, `Tool ${name} missing description`).toBeTruthy()
      expect(toolDef.args, `Tool ${name} missing args`).toBeDefined()
      expect(typeof toolDef.execute, `Tool ${name} missing execute`).toBe("function")
    }
  })

  it("config hook registers the debug agent", async () => {
    const mod = await import("../dist/index.js")
    const hooks = await mod.default({
      client: {} as any,
      project: {} as any,
      directory: "/tmp",
      worktree: "/tmp",
      experimental_workspace: { register: () => {} },
      serverUrl: new URL("http://localhost:3000"),
      $: {} as any,
    })

    const config: Record<string, unknown> = {}
    await hooks.config!(config)

    // Should have registered a debug agent
    expect(config.agent).toBeDefined()
    const agents = config.agent as Record<string, unknown>
    expect(agents.debug).toBeDefined()
  })
})
