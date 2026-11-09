/**
 * dsh-file-menu — browser half.
 *
 * Adds a right-click menu to file names in the conversation. A left click keeps
 * doing what it always did (the right Sidebar preview); a right click offers what
 * a preview cannot: the applications that can open the file — the same list the
 * Shell's own "Open with" menu shows — or copying its absolute path. A double
 * click still opens the file with its default application.
 *
 * The shell loads this as an external classic script, so the whole file is one
 * immediately-invoked function: a rebuild evaluates it again in the realm the
 * page already has, and a top-level `const` would die with "already declared"
 * before registering anything.
 */

(function () {
  'use strict'

  window.__ModuleLoader__.load({
    id: 'dsh-file-menu',

    factory: (require) => {
      const React = require('react')
      const h = React.createElement

      /** Route prefix of this package's Host half. */
      const ROUTE = '/.dsh-file-menu'

      /** Style element id, so a second evaluation reuses one stylesheet. */
      const STYLE_ID = 'dsh-file-menu-style'

      /** Longest string taken off an element or a React prop. */
      const MAX_RAW = 4096

      /** Most candidates kept per gesture, nearest first. */
      const MAX_CANDIDATES = 8

      /** Most applications listed in the menu; the dialog holds the rest. */
      const MAX_APPS = 8

      /** How far up the DOM to look for the element that owns the path. */
      const MAX_DOM_HOPS = 6

      /** How far up the React tree to look for component props. */
      const MAX_FIBER_HOPS = 10

      const COPY = {
        zh: {
          menuTitle: '文件',
          openWith: '打开方式',
          openDefault: '用默认程序打开',
          chooseOther: '选择其他应用…',
          loadingApps: '正在查找可用的应用…',
          defaultBadge: '默认',
          copyFile: '复制文件',
          copy: '复制完整路径',
          copiedFile: '已复制文件',
          checking: '正在检查文件…',
          missing: '找不到这个文件',
          copied: '已复制路径',
          failed: '操作失败',
        },
        en: {
          menuTitle: 'File',
          openWith: 'Open with',
          openDefault: 'Open with default app',
          chooseOther: 'Choose another app…',
          loadingApps: 'Looking for applications…',
          defaultBadge: 'Default',
          copyFile: 'Copy file',
          copy: 'Copy full path',
          copiedFile: 'File copied',
          checking: 'Checking the file…',
          missing: 'This file was not found',
          copied: 'Path copied',
          failed: 'The action failed',
        },
      }

      /** Pending toast dismiss timer; the store owns exactly one. */
      let toastTimer = null

      /** Bumped per application-list request, so a stale answer is dropped. */
      let appsRequest = 0

      /** One shared menu state; the overlay component subscribes to it. */
      const store = {
        state: {
          visible: false,
          x: 0,
          y: 0,
          candidates: [],
          chosen: '',
          resolved: '',
          exists: null,
          isFile: false,
          isDirectory: false,
          note: '',
          tone: 'plain',
          busy: false,
          cwd: '',
          apps: [],
          /** idle | loading | ready | unavailable | hidden */
          appsStatus: 'hidden',
          appsPlatform: '',
          toastText: '',
          toastTone: 'plain',
        },
        listeners: new Set(),
        subscribe(listener) {
          store.listeners.add(listener)
          return () => {
            store.listeners.delete(listener)
          }
        },
        getSnapshot() {
          return store.state
        },
        update(patch) {
          store.state = { ...store.state, ...patch }
          for (const listener of store.listeners) listener()
        },
        /**
         * Show one short-lived line under the conversation.
         *
         * A double click has no menu to report into, so its failures and its
         * "file was not found" answer need a surface of their own.
         */
        notice(message, tone) {
          store.update({ toastText: message, toastTone: tone ?? 'plain' })
          if (toastTimer !== null) clearTimeout(toastTimer)
          toastTimer = setTimeout(() => {
            toastTimer = null
            store.update({ toastText: '' })
          }, 2600)
        },
        open(x, y, candidates, cwd) {
          store.update({
            visible: true,
            x,
            y,
            candidates,
            chosen: candidates.length > 0 ? candidates[0] : '',
            resolved: '',
            exists: null,
            isFile: false,
            isDirectory: false,
            note: '',
            tone: 'plain',
            busy: false,
            cwd: typeof cwd === 'string' ? cwd : '',
            apps: [],
            appsStatus: 'loading',
            appsPlatform: '',
          })
        },
        close() {
          if (!store.state.visible) return
          store.update({ visible: false, busy: false })
        },
      }

      /** Active language, read from the Client locale service. */
      let language = 'zh'

      function text(key) {
        const dict = COPY[language] ?? COPY.zh
        return dict[key] ?? COPY.zh[key] ?? key
      }

      function installStyles() {
        const existing = document.getElementById(STYLE_ID)
        if (existing !== null) return () => {}
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = STYLES
        document.head.append(style)
        return () => {
          style.remove?.()
        }
      }

      /* --------------------------------------------------------------------- *
       * Turning the element under the pointer into a path
       * --------------------------------------------------------------------- */

      /** Drop markdown and line-number decoration around a path. */
      function cleanPath(raw) {
        let value = String(raw ?? '').trim()
        if (value === '') return ''
        value = value.replace(/^[`'"<([{@]+/, '').replace(/[`'">)\]},;]+$/, '')
        const hash = value.indexOf('#')
        if (hash >= 0) value = value.slice(0, hash)
        value = value.replace(/:(\d+)(?::\d+)?$/, '')
        if (value.includes('%')) {
          try {
            value = decodeURIComponent(value)
          } catch {
            // A stray `%` belongs to the name.
          }
        }
        return value.trim()
      }

      /** Whether a string is a path with a separator or a root. */
      function looksLikePath(value) {
        const raw = String(value ?? '').trim()
        if (raw === '' || raw.length > MAX_RAW) return false
        if (/[\r\n\t]/.test(raw)) return false
        if (/^[a-z][a-z\d+.-]*:\/\//i.test(raw) && !/^[a-z]:[\\/]/i.test(raw)) return false
        if (/^(?:mailto|javascript|data|tel):/i.test(raw)) return false
        if (/^[a-z]:[\\/]/i.test(raw)) return true
        if (raw.startsWith('\\\\')) return true
        if (raw.startsWith('/')) return true
        if (raw.startsWith('./') || raw.startsWith('../')) return true
        if (raw.includes('/') || raw.includes('\\')) return /\.[A-Za-z0-9]{1,10}$/.test(cleanPath(raw))
        return false
      }

      /**
       * Whether a string is a bare file name such as `裁切全图.png`.
       *
       * A conversation file chip shows exactly that and keeps the directory
       * outside its text, so this shape is worth a Host lookup once the Session
       * directory is known.
       */
      function looksLikeFileName(value) {
        const raw = String(value ?? '').trim()
        if (raw === '' || raw.length > 260) return false
        if (/[\\/\r\n\t]/.test(raw)) return false
        if (/^[a-z][a-z\d+.-]*:/i.test(raw)) return false
        if (/^\.{1,2}$/.test(raw)) return false
        return /\.[A-Za-z0-9]{1,10}$/.test(raw)
      }

      /** Whether a string is rooted: drive, UNC or POSIX absolute. */
      function startsAbsolute(value) {
        return /^[a-z]:[\\/]/i.test(value) || value.startsWith('\\\\') || value.startsWith('/')
      }

      /**
       * Pull a rooted path out of a longer string.
       *
       * A React prop that reaches this plugin may be a sentence around the path
       * ("产物：D:\WORK1\other.png"), so the sentence is trimmed down to the one
       * rooted path it names rather than being pasted onto the Session directory.
       */
      function extractEmbedded(raw) {
        const boundary = '(?=$|[\\s,，。；;、)\\]}"\':：])'
        const windows = /[a-z]:[\\/][^\r\n\t"'<>|*?]*?\.[a-z0-9]{1,10}/gi
        const withBoundary = new RegExp(`${windows.source}${boundary}`, 'i')
        const windowsMatch = withBoundary.exec(raw)
        if (windowsMatch !== null) return windowsMatch[0]
        const posixMatch = new RegExp(`/[^\\r\\n\\t"'<>|*?]*?\\.[a-z0-9]{1,10}${boundary}`, 'i').exec(raw)
        if (posixMatch !== null) return posixMatch[0]
        return undefined
      }

      /** Text before a path inside a sentence: taken off the front of a bare name. */
      function tailAfterPunctuation(value) {
        const cut = /[：:、，,。;；\s][^：:、，,。;；\s]*$/.exec(value)
        return cut === null ? value : cut[0].replace(/^[：:、，,。;；\s]+/, '')
      }

      /** Classify one string as a strong path, a bare name, or nothing. */
      function asCandidate(value) {
        if (typeof value !== 'string') return undefined
        const trimmed = value.trim()
        if (trimmed === '' || trimmed.length > MAX_RAW) return undefined
        if (/[\r\n\t]/.test(trimmed)) return undefined
        if (startsAbsolute(trimmed)) {
          return looksLikePath(trimmed) ? { value: cleanPath(trimmed), weak: false } : undefined
        }
        // A sentence around the path only reaches the embedded scan when it really
        // carries prose or punctuation; a clean relative path is taken whole.
        if (/[\s\u3000-\u303f\uff00-\uffef]/.test(trimmed)) {
          const embedded = extractEmbedded(trimmed)
          if (embedded !== undefined) return { value: cleanPath(embedded), weak: false }
        }
        if (looksLikePath(trimmed)) return { value: cleanPath(trimmed), weak: false }
        const tail = tailAfterPunctuation(trimmed)
        if (looksLikeFileName(tail)) return { value: cleanPath(tail), weak: true }
        return undefined
      }

      /** Decode a `dsh-resource://file/session/<id>/<path>` address. */
      function fromResourceAddress(href) {
        const prefix = 'dsh-resource://file/'
        if (!href.startsWith(prefix)) return undefined
        const parts = href.slice(prefix.length).split('/')
        if (parts[0] !== 'session' || parts.length < 3) return undefined
        const decoded = cleanPath(parts.slice(2).join('/'))
        return decoded === '' ? undefined : decoded
      }

      /** Path-shaped attributes a file chip may carry. */
      function attributeCandidates(element) {
        const found = []
        const add = (value) => {
          const candidate = asCandidate(value)
          if (candidate !== undefined) found.push(candidate)
        }
        for (const attribute of ['data-path', 'data-file', 'data-file-path', 'data-filepath', 'data-href']) {
          add(element.getAttribute?.(attribute))
        }
        if (element.tagName === 'A') {
          const href = element.getAttribute?.('href')
          if (typeof href === 'string' && href !== '' && !href.startsWith('#') && !/^https?:/i.test(href)) {
            const fromResource = fromResourceAddress(href)
            if (fromResource !== undefined) found.push({ value: fromResource, weak: false })
            else add(href)
          }
        }
        add(element.getAttribute?.('title'))
        const label = element.getAttribute?.('aria-label')
        if (typeof label === 'string') {
          const inner = /\(([^()]+)\)\s*$/.exec(label)
          if (inner !== null) add(inner[1])
        }
        return found
      }

      /**
       * Collect path-shaped strings out of one plain object.
       *
       * React props hold what the component was rendered with, which for a file
       * chip includes the path the click handler will open — even when the DOM
       * itself only carries the label. The walk is bounded in depth, key count and
       * array length so a message-shaped prop cannot pull in the whole transcript.
       */
      function scanValue(value, depth, found) {
        if (value === null || value === undefined) return
        if (typeof value === 'string') {
          const candidate = asCandidate(value)
          if (candidate !== undefined) found.push(candidate)
          return
        }
        if (depth <= 0 || typeof value !== 'object') return
        if (Array.isArray(value)) {
          for (const item of value.slice(0, 6)) scanValue(item, depth - 1, found)
          return
        }
        let keys
        try {
          keys = Object.keys(value)
        } catch {
          return
        }
        for (const key of keys.slice(0, 40)) {
          if (key === 'children' || key === 'ref' || key === 'key' || key === 'style') continue
          let child
          try {
            child = value[key]
          } catch {
            continue
          }
          scanValue(child, depth - 1, found)
        }
      }

      /** Path-shaped strings carried by the React props attached to one DOM node. */
      function propsCandidates(element) {
        const found = []
        let keys
        try {
          keys = Object.keys(element)
        } catch {
          return found
        }
        for (const key of keys) {
          if (!key.startsWith('__reactProps$')) continue
          try {
            scanValue(element[key], 3, found)
          } catch {
            // A frozen or proxied props object is simply skipped.
          }
        }
        return found
      }

      /** Path-shaped strings carried by the component props above one DOM node. */
      function fiberCandidates(element) {
        const found = []
        let keys
        try {
          keys = Object.keys(element)
        } catch {
          return found
        }
        for (const key of keys) {
          if (!key.startsWith('__reactFiber$')) continue
          let fiber
          try {
            fiber = element[key]
          } catch {
            continue
          }
          let hops = 0
          while (fiber !== null && fiber !== undefined && hops < MAX_FIBER_HOPS) {
            if (fiber.memoizedProps !== undefined && fiber.memoizedProps !== null) {
              try {
                scanValue(fiber.memoizedProps, 3, found)
              } catch {
                // Ignore one unreadable fiber and keep walking.
              }
            }
            fiber = fiber.return
            hops += 1
          }
        }
        return found
      }

      /**
       * Every path this gesture could mean, nearest owner first.
       *
       * Order is proximity, then strong before weak: the chip's own name beats a
       * path mentioned further up the message, and a full path beats a bare name
       * at the same distance.
       */
      function collectCandidates(target) {
        const entries = []
        const push = (candidate, rank) => {
          if (candidate === undefined || candidate.value === '') return
          entries.push({ value: candidate.value, weak: candidate.weak, rank })
        }

        let element = target instanceof Element ? target : null
        let hops = 0
        while (element !== null && hops < MAX_DOM_HOPS) {
          if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') break
          if (element.getAttribute?.('contenteditable') === 'true') break
          try {
            for (const candidate of attributeCandidates(element)) push(candidate, hops)
            for (const candidate of propsCandidates(element)) push(candidate, hops)
          } catch {
            // One unreadable node must not lose the whole gesture.
          }
          element = element.parentElement
          hops += 1
        }

        if (target instanceof Element) {
          try {
            for (const candidate of fiberCandidates(target)) push(candidate, 0)
          } catch {
            // React internals differ across versions; the DOM pass still stands.
          }
        }

        entries.sort((left, right) => {
          if (left.rank !== right.rank) return left.rank - right.rank
          if (left.weak !== right.weak) return left.weak ? 1 : -1
          return 0
        })

        const ordered = []
        for (const entry of entries) {
          if (!ordered.includes(entry.value)) ordered.push(entry.value)
          if (ordered.length >= MAX_CANDIDATES) break
        }
        return ordered
      }

      /* --------------------------------------------------------------------- *
       * Host calls
       * --------------------------------------------------------------------- */

      /** Join a Session-relative link against the viewed Session's directory. */
      function absolutize(raw, cwd) {
        if (cwd === '') return raw
        if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\') || raw.startsWith('/')) return raw
        const base = cwd.replace(/[\\/]+$/, '')
        if (base === '') return raw
        const separator = base.includes('\\') ? '\\' : '/'
        const tail = raw.replace(/^\.\//, '')
        const normalized = separator === '\\' ? tail.replace(/\//g, '\\') : tail
        return `${base}${separator}${normalized}`
      }

      /** The workspace directory of the Session the user is looking at. */
      function viewedDirectory(ctx) {
        try {
          const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
          if (sessions === undefined || sessions === null) return ''
          const snapshot = sessions.list?.getSnapshot?.()
          const ids = Array.isArray(snapshot?.ids) ? snapshot.ids : []
          for (const id of ids) {
            let retained
            try {
              retained = sessions.retainInfo?.(id)?.getSnapshot?.()
            } catch {
              retained = undefined
            }
            if ((retained?.retainedBy?.mainView ?? 0) > 0) {
              const cwd = snapshot?.byId?.[id]?.cwd
              return typeof cwd === 'string' ? cwd : ''
            }
          }
        } catch {
          // Without the sessions service the Host still resolves against its own directory.
        }
        return ''
      }

      async function post(route, body) {
        const response = await fetch(ROUTE + route, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return await response.json()
      }

      /**
       * Resolve the first candidate the Host can prove exists.
       *
       * Several candidates come from one gesture, so the first one the Host can
       * prove beats a nearer guess that names nothing on disk. A chip that only
       * shows `report.csv` therefore still resolves inside the Session directory.
       *
       * @returns `{ candidate, answer }` for the winner, `firstAnswer` when none
       * exists, and throws only when the request itself failed.
       */
      async function resolveCandidates(candidates, cwd) {
        let firstAnswer
        for (const candidate of candidates) {
          const request = absolutize(candidate, cwd)
          const answer = await post('/stat', { path: request })
          if (answer === null || typeof answer !== 'object' || answer.ok !== true) continue
          if (firstAnswer === undefined) firstAnswer = answer
          if (answer.exists === true) return { candidate, answer, firstAnswer }
        }
        return { candidate: undefined, answer: undefined, firstAnswer }
      }

      /**
       * Ask the Host for the applications that can open one file.
       *
       * The answer is asynchronous and can outlive the menu it belongs to, so a
       * late answer is dropped instead of replacing the list of a newer gesture.
       */
      async function loadApps(file) {
        const token = (appsRequest += 1)
        try {
          const answer = await post('/apps', { path: file })
          if (token !== appsRequest) return
          if (answer === null || typeof answer !== 'object' || answer.ok !== true) {
            store.update({ apps: [], appsStatus: 'unavailable', appsPlatform: '' })
            return
          }
          const items = Array.isArray(answer.items) ? answer.items : []
          const apps = []
          for (const item of items) {
            if (item === null || typeof item !== 'object') continue
            if (typeof item.name !== 'string' || item.name.trim() === '') continue
            apps.push({ name: item.name, default: item.default === true })
            if (apps.length >= MAX_APPS) break
          }
          store.update({
            apps,
            appsStatus: 'ready',
            appsPlatform: typeof answer.platform === 'string' ? answer.platform : '',
          })
        } catch {
          if (token !== appsRequest) return
          store.update({ apps: [], appsStatus: 'unavailable', appsPlatform: '' })
        }
      }

      /** Fill the open menu with the path the Host confirmed. */
      async function verify(candidates, cwd) {
        const token = candidates.join('\u0000')
        let outcome
        try {
          outcome = await resolveCandidates(candidates, cwd)
        } catch {
          if (store.state.candidates.join('\u0000') !== token) return
          store.update({ note: text('failed'), tone: 'error', appsStatus: 'hidden' })
          return
        }
        if (store.state.candidates.join('\u0000') !== token) return
        if (outcome.answer !== undefined) {
          const resolved = typeof outcome.answer.path === 'string' ? outcome.answer.path : ''
          const isFile = outcome.answer.isFile === true
          store.update({
            chosen: outcome.candidate,
            resolved,
            exists: true,
            isFile,
            isDirectory: outcome.answer.isDirectory === true,
            note: '',
            tone: 'plain',
            apps: [],
            appsStatus: isFile && resolved !== '' ? 'loading' : 'hidden',
            appsPlatform: '',
          })
          if (isFile && resolved !== '') void loadApps(resolved)
          return
        }
        if (outcome.firstAnswer !== undefined) {
          store.update({
            resolved: typeof outcome.firstAnswer.path === 'string' ? outcome.firstAnswer.path : '',
            exists: false,
            note: text('missing'),
            tone: 'warn',
            apps: [],
            appsStatus: 'hidden',
          })
          return
        }
        store.update({ exists: false, note: text('missing'), tone: 'warn', apps: [], appsStatus: 'hidden' })
      }

      /**
       * Open one path through its desktop association with no menu in the way.
       *
       * Used by the double-click gesture, which has no menu to report into: every
       * outcome that is not a launched application becomes a transient line under
       * the conversation instead of silence.
       */
      async function openQuietly(candidates, cwd) {
        let outcome
        try {
          outcome = await resolveCandidates(candidates, cwd)
        } catch {
          store.notice(text('failed'), 'error')
          return
        }
        if (outcome.answer === undefined) {
          store.notice(text('missing'), 'warn')
          return
        }
        const path = typeof outcome.answer.path === 'string' && outcome.answer.path !== ''
          ? outcome.answer.path
          : absolutize(outcome.candidate, cwd)
        try {
          const answer = await post('/open', { path })
          if (answer?.opened === true) return
          store.notice(text('failed'), 'error')
        } catch {
          store.notice(text('failed'), 'error')
        }
      }

      /** Open the chosen path with its default application and report the outcome. */
      async function run(path) {
        if (store.state.busy) return
        store.update({ busy: true, note: '', tone: 'plain' })
        try {
          const answer = await post('/open', { path })
          if (answer?.opened === true) {
            store.close()
            return
          }
          store.update({ note: text('failed'), tone: 'error', busy: false })
        } catch {
          store.update({ note: text('failed'), tone: 'error', busy: false })
        }
      }

      /** Open the path with one named application from the list. */
      async function runApp(path, app) {
        if (store.state.busy) return
        store.update({ busy: true, note: '', tone: 'plain' })
        try {
          const answer = await post('/open', { path, app })
          if (answer?.opened === true) {
            store.close()
            return
          }
          store.update({ note: text('failed'), tone: 'error', busy: false })
        } catch {
          store.update({ note: text('failed'), tone: 'error', busy: false })
        }
      }

      /** Let the user pick an application in the Shell's own dialog. */
      async function openDialog(path) {
        if (store.state.busy) return
        store.update({ busy: true, note: '', tone: 'plain' })
        try {
          const answer = await post('/openwith', { path })
          if (answer?.ok === true) {
            store.close()
            return
          }
          store.update({ note: text('failed'), tone: 'error', busy: false })
        } catch {
          store.update({ note: text('failed'), tone: 'error', busy: false })
        }
      }

      async function copyPath(path) {
        try {
          await navigator.clipboard.writeText(path)
          store.update({ note: text('copied'), tone: 'ok' })
          setTimeout(() => store.close(), 700)
        } catch {
          store.update({ note: text('failed'), tone: 'error' })
        }
      }

      /** Put the file itself on the clipboard, as Explorer's Copy does. */
      async function copyFile(path) {
        if (store.state.busy) return
        store.update({ busy: true, note: '', tone: 'plain' })
        try {
          const answer = await post('/copy', { path })
          if (answer?.ok === true) {
            store.update({ note: text('copiedFile'), tone: 'ok', busy: false })
            setTimeout(() => store.close(), 700)
            return
          }
          store.update({ note: text('failed'), tone: 'error', busy: false })
        } catch {
          store.update({ note: text('failed'), tone: 'error', busy: false })
        }
      }

      /* --------------------------------------------------------------------- *
       * The menu
       * --------------------------------------------------------------------- */

      /** The path the menu acts on: the verified one first. */
      function targetOf(state) {
        return state.resolved !== '' ? state.resolved : state.chosen
      }

      function head(state) {
        const shown = targetOf(state)
        const parts = shown.split(/[\\/]/)
        const name = parts.length > 0 ? parts[parts.length - 1] : shown
        const separator = shown.includes('\\') ? '\\' : '/'
        const dir = parts.length > 1 ? parts.slice(0, -1).join(separator) : ''
        return h(
          'div',
          { className: 'dsh-file-menu-head' },
          h('div', { className: 'dsh-file-menu-name', title: shown }, name === '' ? shown : name),
          dir === '' ? null : h('div', { className: 'dsh-file-menu-dir', title: shown }, dir),
        )
      }

      function item(options) {
        return h(
          'button',
          {
            type: 'button',
            role: 'menuitem',
            className: options.className ?? 'dsh-file-menu-item',
            disabled: options.disabled === true,
            onClick: options.onClick,
          },
          h('span', { className: 'dsh-file-menu-label' }, options.label),
          options.badge === undefined ? null : h('span', { className: 'dsh-file-menu-badge' }, options.badge),
        )
      }

      /** The applications the Shell offers for this file type. */
      function appsSection(state, target) {
        if (state.appsStatus === 'hidden' || state.appsStatus === 'idle') return null
        const busy = state.busy === true

        if (state.appsStatus === 'loading') {
          return h(
            'div',
            { className: 'dsh-file-menu-section' },
            h('div', { className: 'dsh-file-menu-caption' }, text('openWith')),
            h(
              'div',
              { className: 'dsh-file-menu-loading', role: 'status' },
              h('span', { className: 'dsh-file-menu-spinner' }),
              text('loadingApps'),
            ),
          )
        }

        if (state.appsStatus === 'unavailable') {
          return h(
            'div',
            { className: 'dsh-file-menu-section' },
            item({
              label: text('openDefault'),
              disabled: !ready(state) || state.isDirectory === true || busy,
              onClick: () => void run(target),
            }),
          )
        }

        // ready: the Shell listed the handlers this file type can be opened with.
        const rows = state.apps.map((app) =>
          item({
            className: 'dsh-file-menu-app',
            label: app.name,
            badge: app.default ? text('defaultBadge') : undefined,
            disabled: !ready(state) || state.isDirectory === true || busy,
            onClick: () => void runApp(target, app.name),
          }),
        )
        return h(
          'div',
          { className: 'dsh-file-menu-section' },
          h('div', { className: 'dsh-file-menu-caption' }, text('openWith')),
          h('div', { className: 'dsh-file-menu-apps' }, rows),
          item({
            className: 'dsh-file-menu-app is-more',
            label: text('chooseOther'),
            disabled: !ready(state) || state.isDirectory === true || busy,
            onClick: () => void openDialog(target),
          }),
        )
      }

      function ready(state) {
        return state.exists === true
      }

      function buildMenu(state) {
        const target = targetOf(state)
        const noteClass =
          state.tone === 'error'
            ? 'dsh-file-menu-note is-error'
            : state.tone === 'warn'
              ? 'dsh-file-menu-note is-warn'
              : state.tone === 'ok'
                ? 'dsh-file-menu-note is-ok'
                : 'dsh-file-menu-note'

        const appRows =
          state.appsStatus === 'ready'
            ? Math.min(state.apps.length, 5) + 1
            : state.appsStatus === 'loading' || state.appsStatus === 'unavailable'
              ? 1
              : 0
        const estimatedWidth = 276
        const estimatedHeight = 104 + appRows * 31 + (state.note === '' ? 0 : 22)
        const x = Math.max(8, Math.min(state.x, (window.innerWidth || 1024) - estimatedWidth - 8))
        const y = Math.max(8, Math.min(state.y, (window.innerHeight || 768) - estimatedHeight - 8))

        return h(
          'div',
          { className: 'dsh-file-menu-layer' },
          h(
            'div',
            {
              className: 'dsh-file-menu',
              role: 'menu',
              'aria-label': text('menuTitle'),
              style: { left: `${x}px`, top: `${y}px` },
              onContextMenu: (event) => event.preventDefault(),
            },
            head(state),
            state.note === '' ? null : h('div', { className: noteClass }, state.note),
            appsSection(state, target),
            h(
              'div',
              { className: 'dsh-file-menu-items' },
              item({
                label: text('copyFile'),
                disabled: !ready(state) || state.isFile !== true || state.busy === true,
                onClick: () => void copyFile(target),
              }),
              item({
                label: text('copy'),
                disabled: target === '' || state.busy === true,
                onClick: () => void copyPath(target),
              }),
            ),
          ),
        )
      }

      /** One transient line under the conversation, used when no menu is open. */
      function buildToast(state) {
        const className =
          state.toastTone === 'error'
            ? 'dsh-file-menu-toast is-error'
            : state.toastTone === 'warn'
              ? 'dsh-file-menu-toast is-warn'
              : 'dsh-file-menu-toast'
        return h('div', { className, role: 'status', 'aria-live': 'polite' }, state.toastText)
      }

      function FileMenu() {
        const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

        React.useEffect(() => {
          if (state.visible !== true) return undefined
          const onPointerDown = (event) => {
            const path = event.composedPath?.() ?? []
            for (const node of path) {
              if (node?.classList?.contains?.('dsh-file-menu')) return
            }
            store.close()
          }
          const onKeyDown = (event) => {
            if (event.key === 'Escape') store.close()
          }
          const onDismiss = () => store.close()
          /**
           * Scrolling dismisses the menu, but not the application list's own
           * scrolling: a capture-phase listener on window also sees scrolls from
           * inside the menu, and closing on those would make the list unscrollable.
           */
          const onScroll = (event) => {
            const target = event.target
            if (target instanceof Element && target.closest?.('.dsh-file-menu') !== null) return
            store.close()
          }
          document.addEventListener('pointerdown', onPointerDown, true)
          document.addEventListener('keydown', onKeyDown, true)
          window.addEventListener('scroll', onScroll, true)
          window.addEventListener('resize', onDismiss)
          window.addEventListener('blur', onDismiss)
          return () => {
            document.removeEventListener('pointerdown', onPointerDown, true)
            document.removeEventListener('keydown', onKeyDown, true)
            window.removeEventListener('scroll', onScroll, true)
            window.removeEventListener('resize', onDismiss)
            window.removeEventListener('blur', onDismiss)
          }
        }, [state.visible])

        if (state.visible !== true) {
          return state.toastText === '' ? null : buildToast(state)
        }
        try {
          const menu = buildMenu(state)
          if (state.toastText === '') return menu
          return h(React.Fragment, null, buildToast(state), menu)
        } catch (error) {
          console.error('[dsh-file-menu] the menu failed to render', error)
          return state.toastText === '' ? null : buildToast(state)
        }
      }

      /* --------------------------------------------------------------------- *
       * Activation
       * --------------------------------------------------------------------- */

      function readLanguage(ctx) {
        try {
          const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
          const snapshot = locale?.getSnapshot?.() ?? locale?.getLocale?.()
          const active = typeof snapshot?.active === 'string' ? snapshot.active.toLowerCase() : ''
          if (active.startsWith('en')) return 'en'
          if (active !== '') return 'zh'
        } catch {
          // A shell without the locale service keeps the default language.
        }
        return language
      }

      function apply(ctx) {
        const slots = ctx.get('slots')
        if (slots === undefined || slots === null) {
          console.error('[dsh-file-menu] no slot registry: the file menu stays unregistered')
          return
        }

        ctx.effect(() => {
          language = readLanguage(ctx)
          const removeStyles = installStyles()

          const onContextMenu = (event) => {
            if (event.defaultPrevented) return
            if (event.button !== undefined && event.button !== 2 && event.button !== -1) return
            let candidates
            try {
              candidates = collectCandidates(event.target)
            } catch {
              candidates = []
            }
            if (candidates.length === 0) return
            event.preventDefault()
            event.stopPropagation()
            cancelPendingPreview()
            const cwd = viewedDirectory(ctx)
            store.open(event.clientX, event.clientY, candidates, cwd)
            void verify(candidates, cwd)
          }
          document.addEventListener('contextmenu', onContextMenu, true)

          /**
           * Double click opens the file with no preview; a single click previews.
           *
           * The chip's own handler opens the right Sidebar preview on the first
           * click, so a double click would both preview the file and launch it.
           * The first click is therefore taken over and replayed as a synthetic
           * click after a short window. Two clicks on the same chip inside that
           * window are one double click: the replay is cancelled and the file is
           * launched instead. Anything slower is two single clicks and previews —
           * the decision is made by the window, never by the browser's click
           * counter, so the two gestures cannot disagree.
           */
          const CLICK_WINDOW = 260
          let pendingPreview = null

          function cancelPendingPreview() {
            if (pendingPreview === null) return
            clearTimeout(pendingPreview.timer)
            pendingPreview = null
          }

          /** Hand the untouched click back to the page, so its preview opens. */
          function replayPreview(request) {
            const target = request.target
            if (!(target instanceof Element) || target.isConnected !== true) return
            try {
              const event = new MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                view: window,
                detail: 1,
                button: 0,
                buttons: 0,
                clientX: request.clientX,
                clientY: request.clientY,
                screenX: request.screenX,
                screenY: request.screenY,
              })
              event.__dshFileMenuReplay = true
              target.dispatchEvent(event)
            } catch {
              // A page that refuses synthetic events simply keeps the preview closed.
            }
          }

          /** Whether two clicks hit the same chip (one may be a child of it). */
          function sameChip(left, right) {
            if (left === right) return true
            if (!(left instanceof Element) || !(right instanceof Element)) return false
            return left.contains(right) || right.contains(left)
          }

          const onClick = (event) => {
            if (event.__dshFileMenuReplay === true || event.defaultPrevented) return
            // The menu's own rows are ordinary buttons; a delayed replay would
            // make every selection feel laggy, so they are left alone.
            const insideMenu = typeof event.target.closest === 'function'
              && event.target.closest('.dsh-file-menu') !== null
            if (insideMenu) return
            let candidates
            try {
              candidates = collectCandidates(event.target)
            } catch {
              candidates = []
            }
            if (candidates.length === 0) return

            const pending = pendingPreview
            if (pending !== null && sameChip(pending.target, event.target)) {
              // Two clicks on one chip inside the window: a double click.
              event.preventDefault()
              event.stopPropagation()
              cancelPendingPreview()
              store.close()
              void openQuietly(candidates, viewedDirectory(ctx))
              return
            }

            // A click on another chip: let the previous one preview right away.
            if (pending !== null) {
              cancelPendingPreview()
              replayPreview(pending)
            }

            // One click so far: hold the preview back until the window closes.
            event.preventDefault()
            event.stopPropagation()
            const request = {
              target: event.target,
              clientX: event.clientX,
              clientY: event.clientY,
              screenX: event.screenX,
              screenY: event.screenY,
              timer: null,
            }
            request.timer = setTimeout(() => {
              if (pendingPreview !== request) return
              pendingPreview = null
              replayPreview(request)
            }, CLICK_WINDOW)
            pendingPreview = request
          }
          document.addEventListener('click', onClick, true)

          const disposeMenu = slots.inject('shell.overlay', () =>
            slots.register({ name: 'shell.overlay', id: 'dsh-file-menu', order: 20 }, FileMenu),
          )

          let unsubscribeLocale = () => {}
          try {
            const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
            if (locale !== undefined && locale !== null && typeof locale.subscribe === 'function') {
              const stop = locale.subscribe(() => {
                language = readLanguage(ctx)
                store.update({})
              })
              unsubscribeLocale = () => stop?.()
            }
          } catch {
            // Locale follows the boot language; nothing else depends on this.
          }

          return () => {
            unsubscribeLocale()
            if (typeof disposeMenu === 'function') disposeMenu()
            cancelPendingPreview()
            document.removeEventListener('contextmenu', onContextMenu, true)
            document.removeEventListener('click', onClick, true)
            removeStyles()
            store.close()
          }
        }, 'dsh-file-menu: file context menu')
      }

      const STYLES = `
.dsh-file-menu-layer { position: fixed; inset: 0; z-index: 2147483000; pointer-events: none; }
.dsh-file-menu-toast {
  position: fixed; left: 50%; bottom: 34px; transform: translateX(-50%);
  max-width: 420px; padding: 7px 14px; pointer-events: none; box-sizing: border-box;
  background: var(--dsw-alias-bg-overlay, #ffffff);
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.1));
  border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.16);
  font-size: 12px; line-height: 1.5;
  color: var(--dsw-alias-label-secondary, #646a73);
  z-index: 2147483000; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dsh-file-menu-toast.is-warn { color: var(--dsw-alias-state-warn-primary, #b7791f); }
.dsh-file-menu-toast.is-error { color: var(--dsw-alias-state-error-primary, #d33b3b); }
.dsh-file-menu {
  position: fixed; min-width: 224px; max-width: 340px; padding: 5px;
  pointer-events: auto; box-sizing: border-box;
  background: var(--dsw-alias-bg-overlay, #ffffff);
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.1));
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18), 0 1px 3px rgba(0, 0, 0, 0.1);
  font-size: 13px; line-height: 1.5;
  color: var(--dsw-alias-label-primary, #1f2329);
  user-select: none;
}
.dsh-file-menu-head { padding: 5px 8px 7px; }
.dsh-file-menu-name {
  font-weight: 600; font-size: 13px; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
}
.dsh-file-menu-dir {
  margin-top: 1px; font-size: 11px; direction: rtl; text-align: left;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--dsw-alias-label-secondary, #646a73);
}
.dsh-file-menu-note { padding: 0 8px 6px; font-size: 11px; color: var(--dsw-alias-label-secondary, #646a73); }
.dsh-file-menu-note.is-warn { color: var(--dsw-alias-state-warn-primary, #b7791f); }
.dsh-file-menu-note.is-error { color: var(--dsw-alias-state-error-primary, #d33b3b); }
.dsh-file-menu-note.is-ok { color: var(--dsw-alias-state-success-primary, #2f9e5f); }
.dsh-file-menu-section { display: flex; flex-direction: column; gap: 1px; }
.dsh-file-menu-caption {
  padding: 5px 8px 3px; font-size: 11px; font-weight: 600;
  color: var(--dsw-alias-label-secondary, #646a73);
}
.dsh-file-menu-apps {
  display: flex; flex-direction: column; gap: 1px;
  max-height: 188px; overflow-y: auto; overscroll-behavior: contain;
}
.dsh-file-menu-apps::-webkit-scrollbar { width: 8px; }
.dsh-file-menu-apps::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-border-l1, rgba(0,0,0,0.14)); border-radius: 4px;
}
.dsh-file-menu-items {
  display: flex; flex-direction: column; gap: 1px; padding-top: 4px; margin-top: 4px;
  border-top: 0.5px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.1));
}
.dsh-file-menu-item, .dsh-file-menu-app {
  display: flex; align-items: center; width: 100%; box-sizing: border-box;
  height: 30px; flex: 0 0 auto; padding: 0 9px; border: 0; border-radius: 6px;
  background: transparent; font: inherit; font-size: 13px; text-align: left;
  color: var(--dsw-alias-label-primary, #1f2329); cursor: pointer;
}
.dsh-file-menu-item:hover:not(:disabled), .dsh-file-menu-app:hover:not(:disabled) {
  background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.05));
}
.dsh-file-menu-item:focus-visible, .dsh-file-menu-app:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #247bbf);
  outline-offset: -1px;
}
.dsh-file-menu-item:disabled, .dsh-file-menu-app:disabled {
  color: var(--dsw-alias-state-idle-primary, #a0a5ad); cursor: default;
}
.dsh-file-menu-label { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-file-menu-badge {
  flex: 0 0 auto; margin-left: 6px; padding: 0 5px; height: 16px; line-height: 16px;
  border-radius: 4px; font-size: 10px;
  color: var(--dsw-alias-label-secondary, #646a73);
  background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.05));
}
.dsh-file-menu-app.is-more { color: var(--dsw-alias-label-secondary, #646a73); }
.dsh-file-menu-loading {
  display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 9px;
  font-size: 12px; color: var(--dsw-alias-label-secondary, #646a73);
}
.dsh-file-menu-spinner {
  width: 12px; height: 12px; border-radius: 50%; flex: 0 0 auto;
  border: 1.5px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.14));
  border-top-color: var(--dsw-alias-brand-primary, #247bbf);
  animation: dsh-file-menu-spin 0.8s linear infinite;
}
@keyframes dsh-file-menu-spin { to { transform: rotate(360deg); } }
`

      return { name: 'dsh-file-menu', inject: ['slots', 'sessions', 'locale'], apply }
    },
  })
})()
