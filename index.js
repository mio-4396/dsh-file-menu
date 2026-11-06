/**
 * dsh-file-menu — Host half.
 *
 * The browser cannot hand a local path to the desktop, so this half owns the one
 * thing the context menu cannot do by itself: turning a path shown in the
 * conversation into a launched native application (or a file-manager selection).
 *
 * The page reaches these routes over the web server the same way the shipped
 * settings pages do; the routes only ever receive a path string and answer with
 * JSON, so a failure is visible in the menu instead of disappearing into the
 * browser console.
 *
 * @module dsh-file-menu
 */

import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'

export const name = 'dsh-file-menu'

/** Route prefix registered on the DSH web server. */
const ROUTE_PREFIX = '/.dsh-file-menu'

/** Largest request body accepted, in bytes. A path is never this long. */
const MAX_BODY = 64 * 1024

/** Longest path accepted from the page. */
const MAX_PATH = 4096

/** Write one JSON answer. */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.statusCode = status
  if (typeof res.setHeader === 'function') {
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
  }
  res.end(payload)
}

/** Read a bounded JSON body. */
async function readJson(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > MAX_BODY) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  return JSON.parse(text)
}

/** Describe one filesystem entry without throwing on a race. */
function describe(absPath) {
  let info
  try {
    info = statSync(absPath)
  } catch {
    return { exists: false, isFile: false, isDirectory: false, size: 0 }
  }
  return {
    exists: true,
    isFile: info.isFile(),
    isDirectory: info.isDirectory(),
    size: info.size,
  }
}

/**
 * Strip the decoration a path carries when it is lifted out of rendered text.
 *
 * Markdown wraps destinations in angle brackets, code spans add backticks, and a
 * link may point at a line (`app.ts:12`) or a fragment (`README.md#L4-L8`).
 */
function cleanPath(raw) {
  let value = String(raw ?? '').trim()
  if (value === '') return ''
  value = value.replace(/^[`'"<([{]+/, '').replace(/[`'">)\]},;.]+$/, '')
  const hash = value.indexOf('#')
  if (hash >= 0) value = value.slice(0, hash)
  value = value.replace(/:(\d+)(?::\d+)?$/, '')
  if (value.includes('%')) {
    try {
      value = decodeURIComponent(value)
    } catch {
      // A stray `%` is part of the name, not an escape.
    }
  }
  return value.trim()
}

/** Normalize separators so a Windows-style path survives either platform. */
function toNative(value) {
  if (process.platform === 'win32') return value.replace(/\//g, '\\')
  return value
}

/**
 * Resolve one requested path.
 *
 * An absolute path is used as given. A relative one is resolved against the
 * Session working directory first, then the process directory, and the first
 * candidate that exists wins so a file found anywhere is opened rather than a
 * plausible-looking miss.
 */
function resolveRequest(rawPath, directories) {
  const cleaned = cleanPath(rawPath)
  if (cleaned === '') return { ok: false, path: '', exists: false, error: 'empty-path' }
  if (cleaned.length > MAX_PATH) return { ok: false, path: '', exists: false, error: 'path-too-long' }

  const candidate = toNative(cleaned)
  const absolute = path.isAbsolute(candidate)
  const attempts = absolute ? [candidate] : directories.map((base) => path.resolve(base, candidate))
  if (attempts.length === 0) attempts.push(path.resolve(candidate))

  let chosen = attempts[0]
  for (const attempt of attempts) {
    if (existsSync(attempt)) {
      chosen = attempt
      break
    }
  }

  const info = describe(chosen)
  return {
    ok: true,
    path: chosen,
    name: path.basename(chosen),
    relative: !absolute,
    ...info,
  }
}

/** The command that hands a path to the desktop's default association. */
function fileOpener(file) {
  if (process.platform === 'darwin') return ['open', [file]]
  if (process.platform === 'win32') return ['rundll32.exe', ['url.dll,FileProtocolHandler', file]]
  return ['xdg-open', [file]]
}

/** The command that selects a path in the platform file manager. */
function revealOpener(file) {
  if (process.platform === 'darwin') return ['open', ['-R', file]]
  if (process.platform === 'win32') return ['explorer.exe', [`/select,${file}`]]
  return ['xdg-open', [path.dirname(file)]]
}

/** Launch one detached command and report whether the OS accepted it. */
function launch(command, args) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let child
    try {
      child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    } catch (error) {
      finish({ ok: false, error: String(error?.message ?? error) })
      return
    }
    child.once('error', (error) => finish({ ok: false, error: String(error?.message ?? error) }))
    child.once('spawn', () => {
      child.unref()
      finish({ ok: true })
    })
  })
}

/** Register the routes that launch native applications. */
function registerRoutes(ctx, webServer) {

  /** Directories a relative path may be resolved against, most specific first. */
  const directories = () => {
    const bases = []
    try {
      const workingDirectory = ctx.get('workingDirectory')
      const fallback = workingDirectory?.defaultDirectory
      if (typeof fallback === 'string' && fallback !== '') bases.push(fallback)
    } catch {
      // A profile without the service simply falls back to the process directory.
    }
    bases.push(process.cwd())
    return [...new Set(bases)]
  }

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = url.pathname.slice(ROUTE_PREFIX.length)
    try {
      if (route === '/open' && req.method === 'POST') {
        const body = await readJson(req)
        const target = resolveRequest(body.path, directories())
        if (target.ok !== true) return sendJson(res, 200, { opened: false, ...target })
        if (target.exists !== true) return sendJson(res, 200, { opened: false, ...target, error: 'not-found' })
        if (target.isDirectory === true) {
          const revealed = await launch(...revealOpener(target.path))
          return sendJson(res, 200, { opened: revealed.ok === true, revealed: revealed.ok === true, ...target, error: revealed.error })
        }
        const opened = await launch(...fileOpener(target.path))
        return sendJson(res, 200, { opened: opened.ok === true, ...target, error: opened.error })
      }
      if (route === '/stat' && req.method === 'POST') {
        const body = await readJson(req)
        const target = resolveRequest(body.path, directories())
        return sendJson(res, 200, target)
      }
      return sendJson(res, 404, { ok: false, error: 'unknown-route' })
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
    }
  }

  return webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
}

export function apply(ctx) {
  ctx.effect(() => {
    // The browser carrier is mounted by another row, and a boot that applies this
    // plugin early leaves `ctx.get('webServer')` empty, so the routes are
    // registered through an injection: they appear whenever the service arrives
    // instead of being read once at activation time.
    const stop = ctx.inject(['webServer'], (scope) => {
      const webServer = scope.webServer ?? ctx.get('webServer')
      if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
        console.error('[dsh-file-menu] the webServer service has no register(): the file menu routes are unavailable')
        return undefined
      }
      const dispose = registerRoutes(ctx, webServer)
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    })
    return () => {
      if (typeof stop === 'function') stop()
    }
  }, 'dsh-file-menu: native opener routes')
}
