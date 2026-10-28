import { tool } from "@opencode-ai/plugin"
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

// Renders scene JSON(s) by running render/render.mjs to completion inside the
// opencode host process. This exists because the bash tool kills any command
// after 120 s, while a real scene takes 2-15 min — run here, the agent simply
// continues when the masters are written.
// Several scenes run in parallel (each render binds an ephemeral port, uses
// its own Chromium profile and its own per-scene frames dir).

function outDir(root: string) {
  return process.env.MAP_RENDER_OUT
    ? path.resolve(process.env.MAP_RENDER_OUT)
    : path.join(root, "renders")
}

function runRender(
  cwd: string,
  scenePath: string,
  timeoutMs: number
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn("node", [path.join(cwd, "render/render.mjs"), scenePath], {
      cwd,
      env: process.env,
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
      // render.mjs may be mid-encode; escalate if it ignores the signal
      setTimeout(() => {
        try {
          child.kill("SIGKILL")
        } catch {
          /* already gone */
        }
      }, 10_000).unref?.()
    }, timeoutMs)
    child.stdout.on("data", (d) => (stdout += d.toString()))
    child.stderr.on("data", (d) => (stderr += d.toString()))
    child.on("error", (e) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: stderr + String(e), timedOut })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
  })
}

function framingOf(scenePath: string): string | null {
  try {
    return JSON.parse(fs.readFileSync(scenePath, "utf8"))?.scene?.framing ?? null
  } catch {
    return null
  }
}

const tail = (s: string, n = 12) => s.trim().split("\n").slice(-n).join("\n")

// The session root is not reliably context.worktree. Locate the project by
// its own markers — render/render.mjs + recipes/recipes.json — starting from
// the session directory, then the host cwd, then the worktree, walking up a
// few levels. Without this, a relative scene resolves to "/scenes/…" and the
// renderer to "/render/render.mjs".
function isRepoRoot(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, "render/render.mjs")) &&
    fs.existsSync(path.join(dir, "recipes/recipes.json"))
  )
}

function findRepoRoot(...starts: (string | undefined)[]): string | null {
  for (const start of starts) {
    if (!start) continue
    let dir = path.resolve(start)
    for (let i = 0; i < 8; i++) {
      if (isRepoRoot(dir)) return dir
      const up = path.dirname(dir)
      if (up === dir) break
      dir = up
    }
  }
  return null
}

export default tool({
  description:
    "Render one or more scene JSONs (scenes/*.json) to ProRes 4444 masters in ./renders/ " +
    "(or MAP_RENDER_OUT). " +
    "Runs inside the opencode host, so it is NOT subject to the bash tool's 120 s kill: the call " +
    "returns only when the render is finished and the agent continues immediately. Several scenes " +
    "render in parallel. Reveals each master in Finder on success. Use this instead of calling " +
    "render/render.mjs from bash.",
  args: {
    scenes: tool.schema
      .array(tool.schema.string())
      .describe(
        "Scene JSON paths, e.g. ['scenes/demo-01-city-tour.json']. Relative paths are " +
          "resolved against the project root (the tool finds it itself), absolute paths are used as-is."
      ),
    reveal: tool.schema
      .boolean()
      .optional()
      .describe("Reveal each finished master in Finder (default true)"),
    timeoutMinutes: tool.schema
      .number()
      .optional()
      .describe("Hard cap per scene in minutes (default 45)"),
  },
  async execute(args, context) {
    if (!args.scenes.length) return "No scenes given."
    const root = findRepoRoot(context.directory, process.cwd(), process.env.PWD, context.worktree)
    if (!root) {
      return (
        "HARD ERROR — could not locate the project root (needs render/render.mjs + " +
        `recipes/recipes.json). context.directory=${context.directory} cwd=${process.cwd()} ` +
        `worktree=${context.worktree}. Pass absolute scene paths, or run the render detached ` +
        "from a bash call inside the repo (see .opencode/rules/renders.md)."
      )
    }
    const resolveScene = (scene: string) => {
      if (path.isAbsolute(scene)) return scene
      const fromRoot = path.resolve(root, scene)
      if (fs.existsSync(fromRoot)) return fromRoot
      const fromCwd = path.resolve(process.cwd(), scene)
      return fs.existsSync(fromCwd) ? fromCwd : fromRoot
    }
    const reveal = args.reveal !== false
    const timeoutMs = (args.timeoutMinutes ?? 45) * 60_000

    const results = await Promise.all(
      args.scenes.map(async (scene) => {
        const stem = path.basename(scene, ".json")
        const abs = resolveScene(scene)
        if (!fs.existsSync(abs)) return `${stem}: HARD ERROR — scene not found (${abs})`
        const started = Date.now()
        const r = await runRender(root, abs, timeoutMs)
        const secs = ((Date.now() - started) / 1000).toFixed(0)
        if (r.timedOut) {
          return `${stem}: FAILED — killed after ${args.timeoutMinutes ?? 45} min\n${tail(r.stderr)}`
        }
        if (r.code !== 0) {
          return `${stem}: FAILED (exit ${r.code}) after ${secs}s\n${tail(r.stderr)}`
        }
        const framing = framingOf(abs)
        const master = framing ? path.join(outDir(root), `${stem}-${framing}.mov`) : null
        if (!master || !fs.existsSync(master)) {
          return `${stem}: FAILED — render exited 0 but no master found (${master})\n${tail(r.stderr)}`
        }
        if (reveal) {
          try {
            spawn("open", ["-R", master], { stdio: "ignore", detached: true }).unref()
          } catch {
            /* Finder reveal is cosmetic */
          }
        }
        const capture = r.stdout.split("\n").find((l) => l.includes("capture done"))
        return `${stem}: OK in ${secs}s${capture ? ` — ${capture.replace(/^.*capture done:\s*/, "")}` : ""}\n  ${master}`
      })
    )

    return results.join("\n")
  },
})
