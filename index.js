/**
 * dsh-file-menu — Host half.
 *
 * The browser cannot hand a local path to the desktop, and it cannot ask Windows
 * which applications can open a file type. This half owns both: the routes turn
 * a path shown in the conversation into a launched native application (or a
 * file-manager selection), and they list the handlers the Shell itself would
 * offer in its own "Open with" menu.
 *
 * The page reaches these routes over the web server the same way the shipped
 * settings pages do; the routes only ever receive a path string and answer with
 * JSON, so a failure is visible in the menu instead of disappearing into the
 * browser console.
 *
 * Listing and launching a chosen handler need the Shell association API, which
 * Node does not expose, so `openwith.ps1` runs that part through powershell.exe
 * and prints one JSON line. Everything else stays in this process.
 *
 * @module dsh-file-menu
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

export const name = 'dsh-file-menu'

/** Route prefix registered on the DSH web server. */
const ROUTE_PREFIX = '/.dsh-file-menu'

/** Largest request body accepted, in bytes. A path is never this long. */
const MAX_BODY = 64 * 1024

/** Longest path accepted from the page. */
const MAX_PATH = 4096

/** The PowerShell half that talks to the Shell association API. */
const HELPER = fileURLToPath(new URL('./openwith.ps1', import.meta.url))

/** How long one helper call may take before the menu is told it failed. */
const HELPER_TIMEOUT = 20 * 1000

/** How long the "Open with" dialog may take to report that it opened. */
const DIALOG_ACK_TIMEOUT = 10 * 1000

/** How long an application list stays fresh. */
const APPS_TTL = 60 * 1000

/** Applications listed in one menu; the rest are one click away in the dialog. */
const MAX_APPS = 8

const execFileAsync = promisify(execFile)

/** Cached application lists, keyed by lower-cased extension. */
const appCache = new Map()

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

/* ------------------------------------------------------------------------- *
 * Shell association helper
 * ------------------------------------------------------------------------- */

/** The extension a path carries, lower-cased, or "" when it has none. */
function extensionOf(file) {
  const extension = path.extname(file)
  return extension === '' ? '' : extension.toLowerCase()
}

/** Parse the JSON answer the helper printed, ignoring any chatter around it. */
function parseAnswer(text) {
  const source = String(text ?? '')
  const lines = source.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (!line.startsWith('{') || !line.endsWith('}')) continue
    try {
      const value = JSON.parse(line)
      if (value !== null && typeof value === 'object') return value
    } catch {
      // A truncated or half-written line is skipped in favour of an earlier one.
    }
  }
  return undefined
}

/** The arguments that make the helper answer for one file. */
function helperArgs(action, file, extra) {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    HELPER,
    '-Action',
    action,
    '-Path',
    file,
    ...(extra ?? []),
  ]
}

/**
 * Run the helper once and return its answer.
 *
 * The helper reports a failure as `{ok:false}` with a non-zero exit code, so an
 * error from `execFile` still carries the answer on stdout; anything unreadable
 * becomes a plain failure for the caller to show or fall back from.
 */
async function runHelper(action, file, extra) {
  const args = helperArgs(action, file, extra)
  try {
    const { stdout } = await execFileAsync('powershell.exe', args, {
      windowsHide: true,
      timeout: HELPER_TIMEOUT,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    })
    return parseAnswer(stdout) ?? { ok: false, error: 'unreadable-answer' }
  } catch (error) {
    const answer = parseAnswer(typeof error?.stdout === 'string' ? error.stdout : '')
    if (answer !== undefined) return answer
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/**
 * Show the Shell's own "How do you want to open this file?" dialog.
 *
 * The dialog is modal: the helper process blocks until the user closes it. The
 * answer the helper prints *before* entering the dialog therefore decides the
 * request, and the process is left running so the dialog stays up.
 *
 * This spawn deliberately omits `windowsHide`: the Shell will not show the
 * dialog for a process started with a hidden show-state, so the helper hides its
 * own console window right after start instead.
 */
function showDialog(file) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('powershell.exe', helperArgs('dialog', file), {
        windowsHide: false,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch (error) {
      resolve({ ok: false, error: String(error?.message ?? error) })
      return
    }

    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish({ ok: true, dialog: true }), DIALOG_ACK_TIMEOUT)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      const answer = parseAnswer(chunk)
      if (answer === undefined) return
      if (answer.ok === true) {
        finish({ ok: true, dialog: true })
        return
      }
      finish(answer)
      try {
        child.kill()
      } catch {
        // An already finished helper needs no cleanup.
      }
    })
    child.stdout.on('error', () => finish({ ok: false, error: 'helper-pipe-failed' }))
    child.once('error', (error) => finish({ ok: false, error: String(error?.message ?? error) }))
    child.once('exit', () => finish({ ok: false, error: 'dialog-closed-before-showing' }))
  })
}

/** The applications the Shell offers for one file, most useful first. */
function normalizeApps(items) {
  if (!Array.isArray(items)) return []
  const seen = new Set()
  const apps = []
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue
    const appName = typeof item.name === 'string' ? item.name.trim() : ''
    if (appName === '' || seen.has(appName)) continue
    seen.add(appName)
    apps.push({
      name: appName,
      default: item.default === true,
      recommended: item.recommended !== false,
    })
  }
  apps.sort((left, right) => (left.default === right.default ? 0 : left.default ? -1 : 1))
  return apps.slice(0, MAX_APPS)
}

/** The cached list for one extension, when it is still fresh. */
function cachedApps(extension) {
  const entry = appCache.get(extension)
  if (entry === undefined) return undefined
  if (Date.now() - entry.at > APPS_TTL) {
    appCache.delete(extension)
    return undefined
  }
  return entry.value
}

/* ------------------------------------------------------------------------- *
 * Routes
 * ------------------------------------------------------------------------- */

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
      /** Every route that acts on a path starts here. */
      const resolve = async () => {
        const body = await readJson(req)
        return { body, target: resolveRequest(body.path, directories()) }
      }

      if (route === '/open' && req.method === 'POST') {
        const { body, target } = await resolve()
        if (target.ok !== true) return sendJson(res, 200, { opened: false, ...target })
        if (target.exists !== true) return sendJson(res, 200, { opened: false, ...target, error: 'not-found' })

        // A named application means one handler from the "Open with" list; no
        // name keeps the old behaviour of the desktop's default association.
        const app = typeof body.app === 'string' ? body.app.trim() : ''
        if (app !== '') {
          if (process.platform !== 'win32') {
            return sendJson(res, 200, { opened: false, app, ...target, error: 'unsupported-platform' })
          }
          const answer = await runHelper('invoke', target.path, ['-AppName', app])
          return sendJson(res, 200, {
            opened: answer.ok === true,
            app,
            ...target,
            error: answer.ok === true ? undefined : (answer.error ?? 'app-failed'),
          })
        }

        if (target.isDirectory === true) {
          const revealed = await launch(...revealOpener(target.path))
          return sendJson(res, 200, { opened: revealed.ok === true, revealed: revealed.ok === true, ...target, error: revealed.error })
        }
        const opened = await launch(...fileOpener(target.path))
        return sendJson(res, 200, { opened: opened.ok === true, ...target, error: opened.error })
      }
      if (route === '/copy' && req.method === 'POST') {
        const { target } = await resolve()
        if (target.ok !== true) return sendJson(res, 200, { ...target, ok: false })
        if (target.exists !== true) return sendJson(res, 200, { ...target, ok: false, error: 'not-found' })
        if (process.platform !== 'win32') return sendJson(res, 200, { ...target, ok: false, error: 'unsupported-platform' })
        if (target.isFile !== true) return sendJson(res, 200, { ...target, ok: false, error: 'not-a-file' })
        const answer = await runHelper('copy', target.path)
        return sendJson(res, 200, {
          ...target,
          ok: answer.ok === true,
          copied: answer.ok === true,
          error: answer.ok === true ? undefined : (answer.error ?? 'copy-failed'),
        })
      }
      if (route === '/apps' && req.method === 'POST') {
        const { target } = await resolve()
        if (target.ok !== true) return sendJson(res, 200, { ...target, ok: false })
        if (target.exists !== true) return sendJson(res, 200, { ...target, ok: false, platform: process.platform, error: 'not-found' })
        if (process.platform !== 'win32') {
          return sendJson(res, 200, { ...target, ok: true, platform: process.platform, items: [] })
        }
        if (target.isDirectory === true) {
          return sendJson(res, 200, { ...target, ok: true, platform: 'win32', items: [], directory: true })
        }

        const extension = extensionOf(target.path)
        const cached = cachedApps(extension)
        if (cached !== undefined) {
          return sendJson(res, 200, { ...target, ok: true, platform: 'win32', fromCache: true, ...cached })
        }

        const answer = await runHelper('list', target.path)
        if (answer.ok !== true) {
          return sendJson(res, 200, {
            ...target,
            ok: false,
            platform: 'win32',
            error: answer.error ?? 'app-list-unavailable',
          })
        }
        const value = { extension, items: normalizeApps(answer.items) }
        appCache.set(extension, { at: Date.now(), value })
        return sendJson(res, 200, { ...target, ok: true, platform: 'win32', ...value })
      }
      if (route === '/openwith' && req.method === 'POST') {
        const { target } = await resolve()
        if (target.ok !== true) return sendJson(res, 200, { ...target, ok: false })
        if (target.exists !== true) return sendJson(res, 200, { ...target, ok: false, error: 'not-found' })
        if (process.platform !== 'win32') return sendJson(res, 200, { ...target, ok: false, error: 'unsupported-platform' })
        // The Shell may have learned a new handler while the dialog was open.
        appCache.delete(extensionOf(target.path))
        const answer = await showDialog(target.path)
        return sendJson(res, 200, { ...target, ...answer })
      }
      if (route === '/stat' && req.method === 'POST') {
        const { target } = await resolve()
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
