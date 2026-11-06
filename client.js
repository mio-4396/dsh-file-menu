/**
 * dsh-file-menu — browser half.
 *
 * Adds a right-click menu to file names in the conversation. A left click keeps
 * doing what it always did (the right Sidebar preview); a right click offers what
 * a preview cannot: open the file with its default desktop application, or copy
 * its absolute path. A double click opens it straight away.
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

      /** How far up the DOM to look for the element that owns the path. */
      const MAX_DOM_HOPS = 6

      /** How far up the React tree to look for component props. */
      const MAX_FIBER_HOPS = 10

      const COPY = {
        zh: {
          menuTitle: '文件',
          open: '用默认程序打开',
          copy: '复制完整路径',
          checking: '正在检查文件…',
          missing: '找不到这个文件',
          copied: '已复制路径',
          failed: '操作失败',
        },
        en: {
          menuTitle: 'File',
          open: 'Open with default app',
          copy: 'Copy full path',
          checking: 'Checking the file…',
          missing: 'This file was not found',
          copied: 'Path copied',
          failed: 'The action failed',
        },
      }

      /** Pending toast dismiss timer; the store owns exactly one. */
      let toastTimer = null

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

      /** Fill the open menu with the path the Host confirmed. */
      async function verify(candidates, cwd) {
        const token = candidates.join('\u0000')
        let outcome
        try {
          outcome = await resolveCandidates(candidates, cwd)
        } catch {
          if (store.state.candidates.join('\u0000') !== token) return
          store.update({ note: text('failed'), tone: 'error' })
          return
        }
        if (store.state.candidates.join('\u0000') !== token) return
        if (outcome.answer !== undefined) {
          store.update({
            chosen: outcome.candidate,
            resolved: typeof outcome.answer.path === 'string' ? outcome.answer.path : '',
            exists: true,
            isFile: outcome.answer.isFile === true,
            isDirectory: outcome.answer.isDirectory === true,
            note: '',
            tone: 'plain',
          })
          return
        }
        if (outcome.firstAnswer !== undefined) {
          store.update({
            resolved: typeof outcome.firstAnswer.path === 'string' ? outcome.firstAnswer.path : '',
            exists: false,
            note: text('missing'),
            tone: 'warn',
          })
          return
        }
        store.update({ exists: false, note: text('missing'), tone: 'warn' })
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

      async function copyPath(path) {
        try {
          await navigator.clipboard.writeText(path)
          store.update({ note: text('copied'), tone: 'ok' })
          setTimeout(() => store.close(), 700)
        } catch {
          store.update({ note: text('failed'), tone: 'error' })
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
            className: 'dsh-file-menu-item',
            disabled: options.disabled === true,
            onClick: options.onClick,
          },
          h('span', { className: 'dsh-file-menu-label' }, options.label),
        )
      }

      function buildMenu(state) {
        const ready = state.exists === true
        const target = targetOf(state)
        const noteClass =
          state.tone === 'error'
            ? 'dsh-file-menu-note is-error'
            : state.tone === 'warn'
              ? 'dsh-file-menu-note is-warn'
              : state.tone === 'ok'
                ? 'dsh-file-menu-note is-ok'
                : 'dsh-file-menu-note'

        const estimatedWidth = 268
        const estimatedHeight = 168 + (state.note === '' ? 0 : 22)
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
            h(
              'div',
              { className: 'dsh-file-menu-items' },
              item({
                label: text('open'),
                disabled: !ready || state.isDirectory === true || state.busy === true,
                onClick: () => void run(target),
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
          document.addEventListener('pointerdown', onPointerDown, true)
          document.addEventListener('keydown', onKeyDown, true)
          window.addEventListener('scroll', onDismiss, true)
          window.addEventListener('resize', onDismiss)
          window.addEventListener('blur', onDismiss)
          return () => {
            document.removeEventListener('pointerdown', onPointerDown, true)
            document.removeEventListener('keydown', onKeyDown, true)
            window.removeEventListener('scroll', onDismiss, true)
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
            const cwd = viewedDirectory(ctx)
            store.open(event.clientX, event.clientY, candidates, cwd)
            void verify(candidates, cwd)
          }
          document.addEventListener('contextmenu', onContextMenu, true)

          /**
           * Double click opens the file with its default application.
           *
           * The first click has already reached the chip's own handler (the right
           * Sidebar preview), so this gesture only takes over the second one:
           * swallowing it keeps the preview from opening twice, and the launch is
           * what the user asked for. `detail` is the browser's click counter for one
           * press sequence, so `2` is exactly the second click — no timer and no
           * delay on the normal single click.
           */
          const onClick = (event) => {
            if (event.detail !== 2 || event.defaultPrevented) return
            let candidates
            try {
              candidates = collectCandidates(event.target)
            } catch {
              candidates = []
            }
            if (candidates.length === 0) return
            event.preventDefault()
            event.stopPropagation()
            store.close()
            void openQuietly(candidates, viewedDirectory(ctx))
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
  position: fixed; min-width: 208px; max-width: 320px; padding: 5px;
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
.dsh-file-menu-items {
  display: flex; flex-direction: column; gap: 1px; padding-top: 4px;
  border-top: 0.5px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.1));
}
.dsh-file-menu-item {
  display: flex; align-items: center; width: 100%; box-sizing: border-box;
  height: 30px; padding: 0 9px; border: 0; border-radius: 6px;
  background: transparent; font: inherit; font-size: 13px; text-align: left;
  color: var(--dsw-alias-label-primary, #1f2329); cursor: pointer;
}
.dsh-file-menu-item:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.05)); }
.dsh-file-menu-item:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #247bbf);
  outline-offset: -1px;
}
.dsh-file-menu-item:disabled { color: var(--dsw-alias-state-idle-primary, #a0a5ad); cursor: default; }
.dsh-file-menu-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`

      return { name: 'dsh-file-menu', inject: ['slots', 'sessions', 'locale'], apply }
    },
  })
})()
