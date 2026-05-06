/**
 * Debug capture server — lightweight HTTP server that receives probe data
 * from instrumented code (browser or CLI).
 *
 * Endpoints:
 *   POST /capture          — receive probe data (JSON body)
 *   GET  /status           — server health, probe count, sessions
 *   GET  /sessions         — list captured sessions
 *   GET  /session/:id      — read captured data for a session
 *   DELETE /session/:id    — clear session data
 *   POST /shutdown         — gracefully stop the server
 *
 * Pattern matches Cursor's debug mode: agent spins up HTTP server,
 * injected probes POST runtime data here, agent reads it back.
 */
import { tool, type ToolContext } from "@opencode-ai/plugin"
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http"
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync, existsSync, appendFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

const CAPTURE_DIR = join(process.env.RUNTIME_DIR ?? "/tmp", "opencode-debug")

// Module-scoped server instance (persists across tool calls within the session)
let activeServer: Server | null = null
let serverPort = 0
let probeCount = 0

function ensureCaptureDir() {
  if (!existsSync(CAPTURE_DIR)) mkdirSync(CAPTURE_DIR, { recursive: true })
}

interface CapturePayload {
  /** Timestamp (ms since epoch) */
  t: number
  /** Probe name/label */
  p: string
  /** Session ID */
  s: string
  /** Arbitrary debug data */
  d: unknown
}

export interface DebugServerArgs {
  /** Action to perform */
  action: "start" | "stop" | "status"
  /** Port to listen on (default: 9514, auto-finds next available) */
  port?: number
}

export const debugServerTool = tool({
  description:
    "Manage the debug capture server. This is a lightweight HTTP server that receives runtime data " +
    "from instrumented code (both browser and CLI). Start it before injecting probes, then read " +
    "captured data with debug-read-capture.\n\n" +
    "Actions:\n" +
    "- start: Spin up the capture server. Returns the URL probes should POST to.\n" +
    "- stop: Gracefully shut down the server.\n" +
    "- status: Check if the server is running, how many probes received, which sessions exist.",
  args: {
    action: tool.schema
      .enum(["start", "stop", "status"])
      .describe("Action to perform: start, stop, or check status"),
    port: tool.schema
      .number()
      .optional()
      .describe("Port to listen on (default: 9514, auto-finds next available)"),
  },
  async execute(args: DebugServerArgs, _context: ToolContext): Promise<string> {
    ensureCaptureDir()

    if (args.action === "status") {
      return handleStatus()
    }

    if (args.action === "stop") {
      return handleStop()
    }

    if (args.action === "start") {
      return handleStart(args.port ?? 9514)
    }

    return `Unknown action: ${args.action}`
  },
})

async function handleStart(port: number): Promise<string> {
  if (activeServer) {
    return JSON.stringify({
      status: "already-running",
      url: `http://localhost:${serverPort}`,
      port: serverPort,
      probeCount,
      message: "Debug server is already running",
    }, null, 2)
  }

  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // CORS headers — allows browser fetch() from any origin
      res.setHeader("Access-Control-Allow-Origin", "*")
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
      res.setHeader("Access-Control-Allow-Headers", "Content-Type")

      if (req.method === "OPTIONS") {
        res.writeHead(204)
        res.end()
        return
      }

      const url = new URL(req.url ?? "/", `http://localhost:${serverPort}`)

      // POST /capture — receive probe data
      if (req.method === "POST" && url.pathname === "/capture") {
        let body = ""
        req.on("data", (chunk: Buffer) => { body += chunk.toString() })
        req.on("end", () => {
          try {
            const payload: CapturePayload = JSON.parse(body)
            const sessionId = payload.s || "default"
            const capturePath = join(CAPTURE_DIR, `${sessionId}.log`)

            // Append structured probe data
            const entry = JSON.stringify({
              ts: payload.t || Date.now(),
              probe: payload.p,
              session: sessionId,
              data: payload.d,
            }) + "\n"

            if (!existsSync(capturePath)) {
              writeFileSync(capturePath, `=== opencode-debug HTTP capture ===\nSession: ${sessionId}\nStarted: ${new Date().toISOString()}\n===\n`)
            }
            appendFileSync(capturePath, entry)
            probeCount++

            res.writeHead(200, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ ok: true, probeCount }))
          } catch (err) {
            res.writeHead(400, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }))
          }
        })
        return
      }

      // GET /status
      if (req.method === "GET" && url.pathname === "/status") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({
          status: "running",
          port: serverPort,
          probeCount,
          sessions: listSessions(),
        }, null, 2))
        return
      }

      // GET /sessions
      if (req.method === "GET" && url.pathname === "/sessions") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ sessions: listSessions() }, null, 2))
        return
      }

      // GET /session/:id — read captured data
      const sessionMatch = url.pathname.match(/^\/session\/(.+)$/)
      if (req.method === "GET" && sessionMatch) {
        const sid = sessionMatch[1]
        const capturePath = join(CAPTURE_DIR, `${sid}.log`)
        if (existsSync(capturePath)) {
          res.writeHead(200, { "Content-Type": "text/plain" })
          res.end(readFileSync(capturePath, "utf-8"))
        } else {
          res.writeHead(404, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Session not found" }))
        }
        return
      }

      // DELETE /session/:id — clear session
      if (req.method === "DELETE" && sessionMatch) {
        const sid = sessionMatch[1]
        const capturePath = join(CAPTURE_DIR, `${sid}.log`)
        if (existsSync(capturePath)) {
          unlinkSync(capturePath)
        }
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ ok: true, removed: sid }))
        return
      }

      // POST /shutdown
      if (req.method === "POST" && url.pathname === "/shutdown") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ ok: true, message: "Shutting down" }))
        server.close()
        activeServer = null
        return
      }

      // 404
      res.writeHead(404, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "Not found", endpoints: ["/capture", "/status", "/sessions", "/session/:id", "/shutdown"] }))
    })

    // Try the requested port, auto-increment if taken
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" && port < 65535) {
        // Try next port
        server.close()
        server.listen(port + 1, "127.0.0.1")
      } else {
        resolve(JSON.stringify({ status: "error", message: err.message }, null, 2))
      }
    })

    server.listen(port, "127.0.0.1", () => {
      const addr = server.address()
      serverPort = typeof addr === "object" && addr ? addr.port : port
      activeServer = server

      resolve(JSON.stringify({
        status: "started",
        url: `http://localhost:${serverPort}`,
        port: serverPort,
        captureUrl: `http://localhost:${serverPort}/capture`,
        message: `Debug capture server running. Inject probes that POST to http://localhost:${serverPort}/capture`,
      }, null, 2))
    })
  })
}

function handleStop(): string {
  if (!activeServer) {
    return JSON.stringify({ status: "not-running", message: "No debug server is active" }, null, 2)
  }

  activeServer.close()
  activeServer = null
  const finalCount = probeCount
  probeCount = 0

  return JSON.stringify({
    status: "stopped",
    totalProbes: finalCount,
    message: "Debug capture server shut down",
  }, null, 2)
}

function handleStatus(): string {
  return JSON.stringify({
    status: activeServer ? "running" : "stopped",
    port: serverPort || null,
    url: activeServer ? `http://localhost:${serverPort}` : null,
    probeCount,
    sessions: listSessions(),
  }, null, 2)
}

function listSessions(): string[] {
  if (!existsSync(CAPTURE_DIR)) return []
  return readdirSync(CAPTURE_DIR)
    .filter(f => f.endsWith(".log"))
    .map(f => f.replace(".log", ""))
}

/**
 * Get the active server URL (used by instrument tool to know where probes should POST).
 * Returns null if server is not running.
 */
export function getServerUrl(): string | null {
  if (!activeServer) return null
  return `http://localhost:${serverPort}`
}
