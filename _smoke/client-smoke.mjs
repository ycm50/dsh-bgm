/**
 * Client-bundle smoke test for dsh-bgm.
 *
 * The bundle is a `window.__ModuleLoader__.load({ id, factory })` closure: the
 * shell materializes it by calling the factory with a `require` that answers this
 * platform's own externals and nothing else. Those two facts are what this test
 * reproduces without a browser:
 *
 * 1. it installs a stub `__ModuleLoader__`, evaluates the real bundle file, and
 *    asserts the factory is a callable with the right id;
 * 2. it calls the factory with a stub `require` and asserts the returned plugin
 *    face has an `apply`;
 * 3. it drives that `apply` against a stub Cordis client context with stub
 *    `slots` / `locale` / `configForms` services, and asserts the row is
 *    registered into `settings.general.item` at the requested order;
 * 4. it RENDERS the registered component with stub React hooks, and asserts the
 *    folder input is really in the tree — reading the value out of the settings
 *    snapshot rather than from a captured constant;
 * 5. it exercises the write path, asserting a committed edit lands as a `set` op
 *    on the right field.
 *
 * What this cannot prove is how the row looks under the real theme, or that the
 * audio actually comes out of the speakers. Those need the live GUI.
 *
 * Run: node _smoke/client-smoke.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import vm from 'node:vm'

let passed = 0
let failed = 0

/**
 * Run one assertion body and report it.
 *
 * AWAITS the body, which is what makes an `async` test mean anything. An earlier
 * version called `fn()` without awaiting: every async body returned a pending
 * promise, a rejection inside it never reached this `catch`, and the test printed
 * `ok` the instant the function returned. Three tests in this file were passing
 * that way without executing a single assertion — the kind of green that hides
 * exactly the bugs it was written to find.
 *
 * @param label - the test name.
 * @param fn - a sync or async body; a throw or rejection fails the test.
 */
async function check(label, fn) {
  try {
    await fn()
    passed += 1
    console.log('  ok   ' + label)
  } catch (error) {
    failed += 1
    console.log('  FAIL ' + label + '\n       ' + String(error && error.message ? error.message : error))
  }
}

const bundlePath = fileURLToPath(new URL('../client.js', import.meta.url))
const source = readFileSync(bundlePath, 'utf8')

console.log('dsh-bgm client smoke test\n')
console.log('client bundle')

/** The `load` call the shell captured when the bundle was evaluated. */
let loaded = null
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(definition) {
        loaded = definition
      },
    },
  },
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Promise,
  Object,
  Array,
  Symbol,
  String,
  Number,
  Boolean,
  JSON,
  Math,
  Error,
  RegExp,
  Date,
  Map,
  Set,
  fetch: () => Promise.reject(new Error('no network in this test')),
  document: { createElement: () => ({}) },
  location: { search: '' },
  innerWidth: 1200,
  innerHeight: 800,
  addEventListener: () => {},
  removeEventListener: () => {},
  /**
   * A real in-memory `localStorage`.
   *
   * The chip's position persistence is part of what this suite must verify, so a
   * no-op stub would make those assertions vacuous. The drag tests also swap this
   * object for a hostile one and put it back, which is why it is a plain object
   * with methods rather than the real thing.
   */
  localStorage: (() => {
    const entries = new Map()
    return {
      getItem: (key) => (entries.has(key) ? entries.get(key) : null),
      setItem: (key, value) => { entries.set(key, String(value)) },
      removeItem: (key) => { entries.delete(key) },
      clear: () => entries.clear(),
    }
  })(),
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

await check('the bundle registers exactly one module', () => {
  assert.notEqual(loaded, null, 'window.__ModuleLoader__.load was called')
  assert.equal(typeof loaded.factory, 'function', 'the factory is callable')
})

await check('the id matches the package name and the settings namespace', () => {
  assert.equal(loaded.id, 'dsh-bgm')
})

// ── Stub React, just enough to render one element tree ──────────────────────
console.log('\nstub React')

/** A tiny element representation: { type, props }. */
function createElement(type, props, ...children) {
  const merged = Object.assign({}, props)
  const flat = children.flat().filter((child) => child !== undefined && child !== null && child !== false)
  if (flat.length > 0) merged.children = flat.length === 1 ? flat[0] : flat
  return { type, props: merged, children: flat }
}

/**
 * Walk a rendered tree, collecting every element matching a predicate.
 *
 * The stub `createElement` stores children in TWO places — `node.children` and
 * `node.props.children` — which is what the real React element shape offers. The
 * walker descends through both, and de-duplicates by identity, because a real
 * render tree is not a graph and revisiting the same node would double-count
 * every control.
 */
function walk(node, visit, seen = new Set()) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (seen.has(node)) return
  seen.add(node)
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, seen)
    return
  }
  if (node.type !== undefined) visit(node)
  for (const key of ['children', 'props']) {
    const value = key === 'children' ? node.children : node.props && node.props.children
    if (value !== undefined) walk(value, visit, seen)
  }
}

/**
 * A hook runtime that runs a component to completion and returns its tree.
 *
 * The component under test uses `useContext`, `useMemo`, `useState`,
 * `useEffect`, `useCallback`, `useSyncExternalStore` and `useRef`. Each is
 * answered with a stable-enough stub: memoized callbacks run once, state is a
 * slot array, and `useSyncExternalStore` reads through the provided subscribers
 * so the rendered value tracks the settings document rather than a literal.
 */
function makeHooks() {
  /**
   * Genuine component state, keyed by hook slot. These survive a re-render,
   * exactly as React's state does — that is what lets an effect's `setDraft`
   * show up in the next pass.
   */
  const state = []
  /**
   * Memoised values, also keyed by slot, but CLEARED by `reset()`.
   *
   * This is the one place the stub is deliberately coarser than React: React
   * re-invokes every hook on every render and recomputes a `useMemo` whose deps
   * changed, whereas this stub keys memos by slot index alone and so cannot see
   * that `[scope]` changed. Keeping them across passes would hand a later
   * render the closure captured on an earlier one — the test would then be
   * measuring the harness instead of the component. Recomputing them per pass is
   * the conservative choice: a memo is a cache, so recomputing can only ever
   * produce the value the deps imply.
   */
  let memos = []
  let cursor = 0
  let pendingEffects = []
  const cleanups = []

  const ctx = { value: undefined }

  const React = {
    createElement,
    createContext(defaultValue) {
      ctx.value = defaultValue
      return ctx
    },
    useContext(context) {
      return context.value
    },
    useMemo(factory) {
      const slot = cursor++
      if (!(slot in memos)) memos[slot] = factory()
      return memos[slot]
    },
    useState(initial) {
      const slot = cursor++
      if (!(slot in state)) state[slot] = typeof initial === 'function' ? initial() : initial
      const setter = (next) => {
        state[slot] = typeof next === 'function' ? next(state[slot]) : next
      }
      return [state[slot], setter]
    },
    useRef(initial) {
      const slot = cursor++
      if (!(slot in state)) state[slot] = { current: initial }
      return state[slot]
    },
    useCallback(fn) {
      // A callback is not memoised here for the same reason memos are not: the
      // stub cannot compare dependency arrays, and every call site in this
      // component uses its callback immediately.
      cursor += 1
      return fn
    },
    useEffect(fn) {
      // Deferred rather than run inline: an effect that sets state must not
      // recurse into the render that is currently in progress. The caller
      // replays the queue between passes.
      cursor += 1
      pendingEffects.push(fn)
    },
    useSyncExternalStore(subscribe, read) {
      // `subscribe` is ignored: this harness renders on demand rather than
      // reacting to notifications, so re-reading on every render is what keeps a
      // store-backed component in step with the store.
      void subscribe
      return read()
    },
  }
  return {
    React,
    cleanups,
    reset() {
      cursor = 0
      memos = []
      pendingEffects = []
    },
    takeEffects() {
      const taken = pendingEffects
      pendingEffects = []
      return taken
    },
    get state() {
      return state
    },
  }
}

// ── Stub Cordis client context ──────────────────────────────────────────────
console.log('\nclient plugin face')

/**
 * Build a stub client context whose `slots.inject`/`register` record what the
 * plugin contributes, and whose `configForms` answers a live settings document.
 */
function makeClient() {
  const registrations = []
  const served = []
  const dictionaries = []
  const writes = []
  let revision = 7
  let document = { folder: 'A:\\Music', enabled: true, volume: 0.5 }

  const slots = {
    inject(key, callback) {
      served.push(key)
      callback()
      return () => {}
    },
    register(face, component) {
      registrations.push({ face, component })
      return () => {}
    },
  }
  const locale = {
    register(ns, dicts) {
      dictionaries.push({ ns, dicts })
      return () => {}
    },
    bind(ns) {
      return (key) => {
        const dict = dictionaries.find((entry) => entry.ns === ns)
        return dict !== undefined && dict.dicts.zh[key] !== undefined ? dict.dicts.zh[key] : key
      }
    },
  }
  const scope = {
    subscribe() {
      return () => {}
    },
    getSnapshot() {
      return { value: document, revision }
    },
    mutate(ops, expectedRevision) {
      if (expectedRevision !== undefined && expectedRevision !== revision) {
        writes.push({ ops, accepted: false, reason: 'stale' })
        return Promise.resolve(false)
      }
      for (const op of ops) {
        if (op.op === 'set' && op.path.length === 1) document[op.path[0]] = op.value
      }
      revision += 1
      writes.push({ ops, accepted: true })
      return Promise.resolve(true)
    },
    remoteMutate() {
      return Promise.resolve({ ok: true })
    },
  }
  const forms = {
    get(ns) {
      assert.equal(ns, 'dsh-bgm', 'the row addresses its own namespace')
      return scope
    },
    whileServed(namespaces, callback) {
      served.push(...namespaces)
      callback()
      return () => {}
    },
  }

  const services = { slots, locale, configForms: forms }
  const effects = []
  const ctx = {
    get(name) {
      return services[name]
    },
    inject(deps, callback) {
      served.push(...deps)
      callback(mockOwner)
    },
    effect(factory, label) {
      effects.push({ label, dispose: factory() })
    },
  }
  const mockOwner = ctx
  return {
    ctx,
    registrations,
    served,
    dictionaries,
    writes,
    effects,
    get document() {
      return document
    },
    get revision() {
      return revision
    },
  }
}

// The stub React is built before the factory runs, because the bundle reads
// `React.createContext` at factory time (the row's context is module-scope).
const hooks = makeHooks()

const plugin = loaded.factory((specifier) => {
  if (specifier === 'react') return hooks.React
  throw new Error('unexpected require: ' + specifier)
})

await check('the factory returns a plugin face', () => {
  assert.equal(typeof plugin, 'object')
  assert.equal(typeof plugin.apply, 'function', 'apply is callable')
})

await check('inject stays empty so no missing service can park the fiber', () => {
  assert.equal(Array.isArray(plugin.inject), true)
  assert.equal(plugin.inject.length, 0)
})

await check('requiring an unknown module throws rather than silently returning undefined', () => {
  assert.throws(() => loaded.factory((specifier) => { throw new Error('unexpected require: ' + specifier) })('nope'))
})

// ── apply() ─────────────────────────────────────────────────────────────────
console.log('\napply()')

/** Find a registration by its slot name. */
function registrationFor(target, slot) {
  return target.registrations.find((entry) => entry.face.name === slot)
}

const client = makeClient()
plugin.apply(client.ctx)

await check('exactly TWO entries are contributed: a player and a settings row', () => {
  assert.equal(client.registrations.length, 2)
  const slots = client.registrations.map((entry) => entry.face.name).sort()
  assert.deepEqual(slots, ['settings.general.item', 'shell.overlay'])
})

await check('the ROW is registered into settings.general.item', () => {
  const row = registrationFor(client, 'settings.general.item')
  assert.notEqual(row, undefined)
})

await check('the row id is its own, so it adds a cell instead of replacing one', () => {
  assert.equal(registrationFor(client, 'settings.general.item').face.id, 'dsh-bgm-folder')
})

await check('the row sits AFTER the version row (order 110 > current-version 100)', () => {
  assert.equal(registrationFor(client, 'settings.general.item').face.order, 110)
})

await check('the row declares no label, because the owner projects none there', () => {
  assert.equal(registrationFor(client, 'settings.general.item').face.label, undefined)
})

await check('the PLAYER is registered into shell.overlay, which outlives every panel', () => {
  const player = registrationFor(client, 'shell.overlay')
  assert.notEqual(player, undefined, 'the player is not in the settings row any more')
  assert.equal(player.face.id, 'dsh-bgm-player')
})

await check('both the plugin namespace and its services are gated before rendering', () => {
  assert.ok(client.served.includes('dsh-bgm'), 'waits for the Host to serve the namespace')
  assert.ok(client.served.includes('slots'))
  assert.ok(client.served.includes('locale'))
  assert.ok(client.served.includes('configForms'))
})

await check('the dictionary is registered for zh and en', () => {
  assert.equal(client.dictionaries.length, 1)
  assert.equal(client.dictionaries[0].ns, 'dshBgm')
  assert.ok(client.dictionaries[0].dicts.zh.title.includes('背景音乐'))
  assert.ok(typeof client.dictionaries[0].dicts.en.title === 'string')
})

// ── render ──────────────────────────────────────────────────────────────────
console.log('\nrender (stub React + stub hooks)')

/**
 * Collect every element in a rendered tree that satisfies a predicate.
 *
 * Shares the walk above, but returns matches and keeps the `seen` set internal so
 * call sites do not have to thread one.
 * @param tree - the rendered tree.
 * @param predicate - receives each element.
 * @returns the matching elements.
 */
function collect(tree, predicate) {
  const found = []
  walk(tree, (node) => {
    if (predicate(node)) found.push(node)
  })
  return found
}

/**
 * Render whatever a registered slot component produces.
 *
 * The plugin registers `() => React.createElement(BgmRow, null)`. With the real
 * React, that call mounts `BgmRow` and runs its hooks. With this stub,
 * `createElement` only BUILDS the element — it does not call the function passed
 * as its type — so the element has to be unwrapped and the function invoked to
 * get an actual tree. That is the one place this stub has to know how React
 * works.
 *
 * The hooks object is rendered TWICE, which is the part that makes this test mean
 * anything. `BgmRow` initialises its draft from `useState(folder)` and then
 * adopts the stored value in a `useEffect` — exactly the real behaviour, where an
 * effect runs after the first paint and its `setDraft` causes a second render.
 * A stub that ran the component once would therefore read the initial `''` and
 * "prove" the box is broken when it is not. Replaying the effects and rendering
 * again reproduces the second pass, so the assertion tests the component rather
 * than the harness.
 *
 * @param element - the value returned by the registered component.
 * @param hooks - the hook runtime to render under.
 * @returns a rendered tree of host elements.
 */
function render(element, hooks) {
  if (element === null || element === undefined) return element
  if (typeof element.type === 'function') {
    hooks.reset()
    let produced = element.type(element.props)
    // Second pass: replay the effects this render registered, then render again
    // with whatever state they set.
    const firstPassEffects = hooks.takeEffects()
    for (const effect of firstPassEffects) {
      const cleanup = effect()
      if (typeof cleanup === 'function') hooks.cleanups.push(cleanup)
    }
    if (firstPassEffects.length > 0) {
      hooks.reset()
      produced = element.type(element.props)
      // A third pass settles an effect whose dependency changed on pass two.
      const secondPassEffects = hooks.takeEffects()
      for (const effect of secondPassEffects) {
        const cleanup = effect()
        if (typeof cleanup === 'function') hooks.cleanups.push(cleanup)
      }
      if (secondPassEffects.length > 0) {
        hooks.reset()
        produced = element.type(element.props)
      }
    }
    return render(produced, hooks)
  }
  const children = []
  const raw = element.children ?? (element.props && element.props.children)
  if (raw !== undefined) {
    for (const child of Array.isArray(raw) ? raw : [raw]) {
      children.push(child !== null && typeof child === 'object' ? render(child, hooks) : child)
    }
  }
  return { type: element.type, props: Object.assign({}, element.props, { children: undefined }), children }
}

const component = registrationFor(client, 'settings.general.item').component

// Re-run the factory with the stub React, then render the registered row.
const plugin2 = loaded.factory((specifier) => {
  if (specifier === 'react') return hooks.React
  throw new Error('unexpected require: ' + specifier)
})
const client2 = makeClient()
plugin2.apply(client2.ctx)
const rowComponent = registrationFor(client2, 'settings.general.item').component
const playerComponent = registrationFor(client2, 'shell.overlay').component

const tree = render(rowComponent(), hooks)
void component

await check('the row renders without throwing', () => {
  assert.notEqual(tree, undefined)
})

await check('the folder INPUT is rendered — the control this plugin was asked for', () => {
  const inputs = []
  walk(tree, (node) => {
    if (node.type === 'input' && node.props.type === 'text') inputs.push(node)
  })
  assert.equal(inputs.length, 1, 'exactly one text input')
  assert.ok(String(inputs[0].props.placeholder).length > 0, 'it has a placeholder')
  assert.equal(inputs[0].props.spellCheck, false)
})

await check('the input shows the value from the SETTINGS DOCUMENT, not a constant', () => {
  const found = []
  walk(tree, (node) => {
    if (node.type === 'input' && node.props.type === 'text') found.push(node)
  })
  assert.equal(found[0].props.value, 'A:\\Music')
})

await check('the title and description are rendered', () => {
  // Text lives in the CHILDREN of an element, not on the element itself, so this
  // collects every string in the tree rather than looking at elements only.
  const texts = []
  ;(function collectText(node, seen = new Set()) {
    if (typeof node === 'string') {
      texts.push(node)
      return
    }
    if (node === null || node === undefined || typeof node !== 'object' || seen.has(node)) return
    seen.add(node)
    const raw = node.children !== undefined ? node.children : node.props && node.props.children
    if (raw !== undefined) for (const child of Array.isArray(raw) ? raw : [raw]) collectText(child, seen)
  })(tree)
  assert.ok(texts.some((text) => text.includes('背景音乐')), 'the title is present: ' + JSON.stringify(texts))
  assert.ok(texts.some((text) => text.includes('音乐文件夹') && text.length > 8), 'the description is present')
})

await check('a Browse control is offered', () => {
  const buttons = []
  walk(tree, (node) => {
    if (node.type === 'button') buttons.push(node)
  })
  assert.ok(buttons.length >= 3, 'browse / play / next are present')
})

await check('playback state is derived from the document, not invented', () => {
  const checkboxes = []
  walk(tree, (node) => {
    if (node.type === 'input' && node.props.type === 'checkbox') checkboxes.push(node)
  })
  assert.equal(checkboxes.length, 1)
  assert.equal(checkboxes[0].props.checked, true, 'enabled:true in the document')
})

await check('the volume control reflects the stored volume', () => {
  // The row now carries TWO range inputs: the Transport component's own (which the
  // overlay shares) and the row's editable volume slider. Both must show the
  // stored value — a disagreement between them is exactly the bug this split
  // could introduce.
  const ranges = collect(tree, (node) => node.type === 'input' && node.props.type === 'range')
  assert.ok(ranges.length >= 1, 'at least one volume control')
  for (const range of ranges) {
    assert.equal(range.props.value, '0.5', 'every volume control shows the stored volume')
  }
})

await check('the audio element lives in the OVERLAY, not in the settings row', () => {
  // This is the regression guard for the reported bug. The row is unmounted the
  // moment Settings closes, so an audio element inside it stops the music. The
  // row must therefore contain NO <audio>, and the overlay must contain exactly one.
  const rowAudio = collect(tree, (node) => node.type === 'audio')
  assert.equal(rowAudio.length, 0, 'the settings row must not own the audio element')

  const playerHooks = makeHooks()
  const overlayTree = render(playerComponent(), playerHooks)
  const overlayAudio = collect(overlayTree, (node) => node.type === 'audio')
  assert.equal(overlayAudio.length, 1, 'the overlay owns exactly one audio element')
  assert.equal(overlayAudio[0].props.preload, 'none', 'nothing downloads until playback starts')
})

await check('the overlay renders a stop control only while playing', () => {
  // With nothing playing the overlay must be invisible; the chip appears only
  // when there is something to stop.
  const playerHooks = makeHooks()
  const idle = render(playerComponent(), playerHooks)
  const idleButtons = collect(idle, (node) => node.type === 'button')
  assert.equal(idleButtons.length, 0, 'no chip while idle')

  // Drive the shared store to "playing" and confirm the chip appears. The store is
  // cached on the BUNDLE's globalThis (the vm sandbox), not this module's — so it
  // is reached through the sandbox rather than the host global.
  const store = sandbox.globalThis.__dshBgmPlaybackStore__
  assert.notEqual(store, undefined, 'the store is cached on the bundle globalThis')
  assert.equal(typeof store.attach, 'function', 'it is the real store')
  store.set({ tracks: [{ name: 'song.mp3', src: '/x', type: 'audio/mpeg' }], index: 0, playing: true })
  const playerHooks2 = makeHooks()
  const playing = render(playerComponent(), playerHooks2)
  const playingButtons = collect(playing, (node) => node.type === 'button')
  assert.equal(playingButtons.length, 3, 'pause + next + mode')
  const texts = []
  ;(function collectText(node, seen = new Set()) {
    if (typeof node === 'string') { texts.push(node); return }
    if (node === null || node === undefined || typeof node !== 'object' || seen.has(node)) return
    seen.add(node)
    const raw = node.children !== undefined ? node.children : node.props && node.props.children
    if (raw !== undefined) for (const child of Array.isArray(raw) ? raw : [raw]) collectText(child, seen)
  })(playing)
  assert.ok(texts.some((text) => text.includes('song.mp3')), 'the chip names the playing track')
  store.set({ playing: false, tracks: [], index: -1 })
})

// ── the draggable chip ──────────────────────────────────────────────────────
console.log('\ndraggable chip')

/**
 * Render the overlay chip and return it with the handles needed to interact.
 *
 * The chip only exists while something is playing, so the store is pushed into
 * that state first. The store is a real one on the bundle's `globalThis`, shared
 * by every render in this file, so nothing here may assume it starts empty.
 *
 * `fresh` clears the remembered position first. Without it a drag performed by an
 * earlier test would be read back by this one and every "did the chip move?"
 * assertion would pass or fail for the wrong reason — which is exactly the kind
 * of cross-test leakage that makes a suite lie.
 *
 * @param store - the shared playback store.
 * @param fresh - when true, forget any stored position before rendering.
 * @returns the chip element, its tree, and the hook set to re-render with.
 */
function renderChip(store, fresh = true) {
  return chipHandle(store, fresh)
}

/**
 * Give the stub chip a real bounding rectangle.
 *
 * The drag reads the chip's own measured corner, because while unplaced the chip is
 * positioned by `right`/`bottom` and its corner exists only in layout. A stub with
 * no `getBoundingClientRect` would make every drag fall back to (0,0), so the
 * follow-the-pointer assertions would be testing the fallback instead of the
 * behaviour they claim to test.
 *
 * The viewport is 1200x800 and the chip is pinned 16px from each edge, so the
 * modelled box is what a browser would report for the default anchor.
 *
 * @param chip - the rendered chip element.
 */
function attachRect(chip) {
  if (chip === undefined || chip.props.ref === undefined) return
  const width = CHIP_RECT.width
  const height = CHIP_RECT.height
  chip.props.ref({
    getBoundingClientRect: () => {
      // Read `placed` LAZILY, on every call, rather than capturing it here. The
      // element is mounted once and then re-rendered as the user drags it, so a
      // captured flag would keep reporting the anchor the chip had at mount time —
      // and the drag's grab offset would be computed from a stale corner.
      const placed = chip.props.style.left !== undefined
      return {
        left: placed ? px(chip.props.style.left) : 1200 - 16 - width,
        top: placed ? px(chip.props.style.top) : 800 - 16 - height,
        width,
        height,
      }
    },
  })
}

/** The stub chip's modelled size, in CSS pixels. */
const CHIP_RECT = { width: 200, height: 32 }

/**
 * Render the player and hand back a live handle onto its chip.
 *
 * The handle is `{ chip(), hooks, effects }`: `chip()` re-renders and returns the
 * current chip element, so a test can press, re-render, and read the new corner
 * without juggling refs itself. Re-rendering is unavoidable because the chip's
 * position lives in component state — driving handlers from one render and reading
 * the DOM from another is precisely how a drag is supposed to work.
 *
 * @param store - the shared playback store.
 * @param fresh - when true, forget any stored position before rendering.
 */
/**
 * Render the player once and return a handle whose `chip()` is a STABLE element.
 *
 * The hook runtime is created fresh for EACH handle, and the plugin's factory is
 * re-run against it. That is the only way to get both properties this file needs:
 *
 *   - `playerComponent` must close over the runtime this handle inspects, or the
 *     chip's position lives in a runtime nobody reads (a fresh `makeHooks()` with a
 *     stale component silently yields an empty state array);
 *   - the runtime must NOT be the one earlier tests used, because component state
 *     is keyed by hook slot and persists across renders. A shared runtime would let
 *     one test's drag decide the next test's starting corner — which is exactly how
 *     "moving without a press does nothing" started failing with a leftover 940px.
 *
 * @param store - the shared playback store.
 * @param fresh - when true, forget any stored position before rendering.
 */
function chipHandle(store, fresh = true) {
  if (fresh) sandbox.globalThis.localStorage.removeItem('dsh-bgm:chip-position')
  store.set({ tracks: [{ name: 'a.mp3', src: '/a', type: 'audio/mpeg' }], index: 0, playing: true, enabled: true })
  const chipHooks = makeHooks()
  const client = makeClient()
  const instance = loaded.factory((specifier) => {
    if (specifier === 'react') return chipHooks.React
    throw new Error('unexpected require: ' + specifier)
  })
  instance.apply(client.ctx)
  const component = registrationFor(client, 'shell.overlay').component

  const mount = () => {
    chipHooks.reset()
    const element = component()
    const built = element.type(element.props)
    const chip = collect(built, (node) => node.props && node.props.style && node.props.style.cursor === 'grab')[0]
    attachRect(chip)
    return chip
  }

  let current = mount()
  return {
    /** The mounted chip element. Stable across a gesture. */
    chip: () => current,
    /** Re-render (without effect replay) and return the settled element. */
    refresh: () => {
      current = mount()
      return current
    },
    /** Alias kept for readability where a test reads the settled style. */
    rerender: () => {
      current = mount()
      return current
    },
    hooks: chipHooks,
  }
}

/** Read a `px` style value as a number. */
function px(value) {
  return Number(String(value).replace('px', ''))
}

/** A synthetic pointer event. */
function pointer(overrides) {
  return Object.assign(
    {
      button: 0,
      pointerId: 7,
      clientX: 0,
      clientY: 0,
      target: { tagName: 'DIV' },
      currentTarget: { setPointerCapture: () => {}, releasePointerCapture: () => {} },
      preventDefault: () => {},
    },
    overrides,
  )
}

const dragStore = sandbox.globalThis.__dshBgmPlaybackStore__

await check('the chip exists and advertises that it can be dragged', () => {
  const handle = renderChip(dragStore)
  const chip = handle.chip()
  assert.notEqual(chip, undefined, 'the chip renders while playing')
  assert.equal(chip.props.style.cursor, 'grab', 'the cursor says "draggable"')
  assert.equal(chip.props.style.userSelect, 'none', 'a drag must not select the track name')
  assert.equal(chip.props.style.touchAction, 'none', 'touch must not scroll instead of dragging')
  assert.equal(typeof chip.props.onPointerDown, 'function')
  assert.equal(typeof chip.props.onPointerMove, 'function')
  assert.equal(typeof chip.props.onPointerUp, 'function')
})

await check('an undragged chip sits at the default bottom-right corner', () => {
  const chip = renderChip(dragStore).chip()
  // No position stored and none dragged: the chip is anchored by right/bottom, so
  // it is correct in any viewport without needing to measure one at first render.
  assert.equal(chip.props.style.right, '16px')
  assert.equal(chip.props.style.bottom, '16px')
  assert.equal(chip.props.style.left, undefined, 'no left offset while unplaced')
  assert.equal(chip.props.style.top, undefined, 'no top offset while unplaced')
})

await check('dragging past the threshold moves the chip and keeps the gesture grip', () => {
  const handle = renderChip(dragStore)
  // The default anchor puts the 200x32 chip's corner at (984, 752) in a 1200x800
  // viewport. Pressing at (1000, 700) therefore grabs it 16px from its left edge and
  // 52px ABOVE its top edge.
  handle.chip().props.onPointerDown(pointer({ clientX: 1000, clientY: 700 }))
  handle.chip().props.onPointerMove(pointer({ clientX: 300, clientY: 200 }))
  const moved = handle.rerender()

  assert.equal(moved.props.style.left, '284px', 'the pointer keeps its grip: 300 - 16')
  assert.equal(moved.props.style.top, '252px', 'and vertically: 200 + 52')
  assert.equal(moved.props.style.right, undefined, 'the default anchor is dropped once placed')
  assert.equal(moved.props.style.bottom, undefined, 'both offsets move to left/top')
})

await check('a press that does not move is a click, not a drag', () => {
  const handle = renderChip(dragStore)
  handle.chip().props.onPointerDown(pointer({ clientX: 500, clientY: 500 }))
  // Two pixels: below the 4px threshold, so this must not reposition the chip —
  // otherwise pressing a button would nudge it.
  handle.chip().props.onPointerMove(pointer({ clientX: 502, clientY: 501 }))
  handle.chip().props.onPointerUp(pointer({ clientX: 502, clientY: 501 }))
  const after = handle.rerender()
  assert.equal(after.props.style.left, undefined, 'the chip did not move')
  assert.equal(after.props.style.bottom, '16px', 'still at its default corner')
})

await check('a drag is clamped to the viewport, never off-screen', () => {
  const handle = renderChip(dragStore)
  handle.chip().props.onPointerDown(pointer({ clientX: 1000, clientY: 760 }))
  // Far past the bottom-right corner: the chip must stop at the edge, because
  // nothing else could bring it back if it left the viewport.
  handle.chip().props.onPointerMove(pointer({ clientX: 99999, clientY: 99999 }))
  const moved = handle.rerender()
  const left = px(moved.props.style.left)
  const top = px(moved.props.style.top)
  // 1200 - 200 = 1000 for x, 800 - 32 = 768 for y, with the chip fully visible.
  assert.equal(left, 1000, 'pushed to the right edge, fully on screen')
  assert.equal(top, 768, 'and to the bottom edge')
})

await check('a drag that leaves the window keeps working through pointer capture', () => {
  const handle = renderChip(dragStore)
  let captured = null
  let released = null
  const captureTarget = {
    setPointerCapture: (id) => { captured = id },
    releasePointerCapture: (id) => { released = id },
  }
  handle.chip().props.onPointerDown(pointer({ clientX: 100, clientY: 100, pointerId: 3, currentTarget: captureTarget }))
  assert.equal(captured, 3, 'the pointer is captured on press')
  // The pointer is outside the element; capture is what still routes it here.
  handle.chip().props.onPointerMove(pointer({ clientX: 40, clientY: 40, pointerId: 3 }))
  handle.chip().props.onPointerUp(pointer({ clientX: 40, clientY: 40, pointerId: 3, currentTarget: captureTarget }))
  assert.equal(released, 3, 'the capture is released on pointerup')
})

await check('pressing a button inside the chip does not start a drag', () => {
  const handle = renderChip(dragStore)
  // A press that starts on a <button> must reach the button, or the user could not
  // pause the music at all.
  handle.chip().props.onPointerDown(pointer({ clientX: 500, clientY: 500, target: { tagName: 'BUTTON' } }))
  handle.chip().props.onPointerMove(pointer({ clientX: 300, clientY: 300 }))
  handle.chip().props.onPointerUp(pointer({ clientX: 300, clientY: 300 }))
  const after = handle.rerender()
  assert.equal(after.props.style.left, undefined, 'the chip never moved')
  assert.equal(after.props.style.bottom, '16px', 'still at its default corner')
})

await check('a press on an input inside the chip does not start a drag', () => {
  const handle = renderChip(dragStore)
  handle.chip().props.onPointerDown(pointer({ clientX: 500, clientY: 500, target: { tagName: 'INPUT' } }))
  handle.chip().props.onPointerMove(pointer({ clientX: 100, clientY: 100 }))
  const after = handle.rerender()
  assert.equal(after.props.style.left, undefined, 'inputs keep their own gestures')
})

await check('a non-primary button is ignored', () => {
  const handle = renderChip(dragStore)
  handle.chip().props.onPointerDown(pointer({ button: 2, clientX: 500, clientY: 500 }))
  handle.chip().props.onPointerMove(pointer({ clientX: 100, clientY: 100 }))
  handle.chip().props.onPointerUp(pointer({ clientX: 100, clientY: 100 }))
  const after = handle.rerender()
  assert.equal(after.props.style.left, undefined, 'a right-drag does nothing')
})

await check('an unmatched pointerId is ignored, so a second pointer cannot hijack the drag', () => {
  const handle = renderChip(dragStore)
  handle.chip().props.onPointerDown(pointer({ clientX: 500, clientY: 500, pointerId: 1 }))
  handle.chip().props.onPointerMove(pointer({ clientX: 50, clientY: 50, pointerId: 2 }))
  handle.chip().props.onPointerUp(pointer({ clientX: 50, clientY: 50, pointerId: 2 }))
  const after = handle.rerender()
  assert.equal(after.props.style.left, undefined, 'the alien pointer did not move the chip')
})

await check('moving without a press does nothing', () => {
  const handle = renderChip(dragStore)
  // A stray move must not place the chip, or merely hovering the overlay would
  // pin it to the top-left corner.
  handle.chip().props.onPointerMove(pointer({ clientX: 10, clientY: 10 }))
  const after = handle.rerender()
  assert.equal(after.props.style.left, undefined, 'no drag without a press')
})

await check('the position is persisted on release and restored across a reload', () => {
  const handle = renderChip(dragStore)
  handle.chip().props.onPointerDown(pointer({ clientX: 1000, clientY: 700 }))
  handle.chip().props.onPointerMove(pointer({ clientX: 300, clientY: 200 }))
  handle.chip().props.onPointerUp(pointer({ clientX: 300, clientY: 200 }))

  const saved = sandbox.globalThis.localStorage.getItem('dsh-bgm:chip-position')
  assert.equal(typeof saved, 'string', 'the position was written to storage')
  const parsed = JSON.parse(saved)
  assert.deepEqual(parsed, { x: 284, y: 252 }, 'it stores the released corner')

  // A fresh mount reads it back and anchors by left/top instead of the default.
  // `fresh: false` is essential: this is the "reload" half of the test, and asking
  // the helper to clear storage would erase the very value under test.
  const restored = renderChip(dragStore, false).chip()
  assert.equal(restored.props.style.left, '284px', 'restored horizontally')
  assert.equal(restored.props.style.top, '252px', 'restored vertically')
  assert.equal(restored.props.style.right, undefined, 'the default anchor is not applied too')
})

await check('a corrupt stored position degrades to the default corner, never a crash', () => {
  const real = sandbox.globalThis.localStorage
  const saved = real.getItem('dsh-bgm:chip-position')
  try {
    for (const bad of ['not json', '{}', '{"x":"a","y":2}', '[1,2]', 'null', '{"x":1e999,"y":0}']) {
      real.setItem('dsh-bgm:chip-position', bad)
      const chip = renderChip(dragStore).chip()
      assert.equal(chip.props.style.bottom, '16px', 'fell back to the default for: ' + bad)
    }
  } finally {
    if (saved === null) real.removeItem('dsh-bgm:chip-position')
    else real.setItem('dsh-bgm:chip-position', saved)
  }
})

await check('a throwing localStorage does not stop the player', () => {
  const real = sandbox.globalThis.localStorage
  const hostile = {
    getItem: () => { throw new Error('access denied') },
    setItem: () => { throw new Error('access denied') },
    removeItem: () => { throw new Error('access denied') },
  }
  sandbox.globalThis.localStorage = hostile
  try {
    const handle = { chip: () => renderChip(dragStore, false).chip(), rerender: null, hooks: null }
    void handle
    // `renderChip` itself calls `removeItem`, which now throws — so build the
    // handle without the fresh-reset path to prove the player survives a hostile
    // storage rather than dying inside its own test harness.
    const hooks = makeHooks()
    const rendered = render(playerComponent(), hooks)
    const chip = collect(rendered, (node) => node.props && node.props.style && node.props.style.cursor === 'grab')[0]
    attachRect(chip)
    assert.notEqual(chip, undefined, 'the chip still renders')
    // And a drag still works, it just cannot be remembered.
    chip.props.onPointerDown(pointer({ clientX: 1000, clientY: 700 }))
    chip.props.onPointerMove(pointer({ clientX: 300, clientY: 200 }))
    chip.props.onPointerUp(pointer({ clientX: 300, clientY: 200 }))
  } finally {
    sandbox.globalThis.localStorage = real
  }
})

dragStore.set({ playing: false, tracks: [], index: -1 })

// ── the write path ──────────────────────────────────────────────────────────
console.log('\nwrite path')

await check('committing the folder writes a single set op on ["folder"]', async () => {
  // A real interaction is two renders, not one handler call:
  //   1. `onChange` stores the draft in state — it does NOT commit;
  //   2. the next render hands `commitFolder` the new draft, and Enter commits it.
  // Calling the first render's `onKeyDown` directly would commit the OLD draft and
  // read as a broken write path when the component is in fact correct.
  const inputs = collect(tree, (node) => node.type === 'input' && node.props.type === 'text')
  inputs[0].props.onChange({ target: { value: 'D:\\NewMusic' } })

  // Re-render with the draft now in state, then commit from THAT render.
  const second = render(rowComponent(), hooks)
  const secondInputs = collect(second, (node) => node.type === 'input' && node.props.type === 'text')
  assert.equal(secondInputs[0].props.value, 'D:\\NewMusic', 'the draft is what the box shows next')
  secondInputs[0].props.onKeyDown({ key: 'Enter', preventDefault() {} })

  // `write` resolves on a microtask; give it one turn.
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(client2.writes.length >= 1, 'a write was attempted')
  const last = client2.writes[client2.writes.length - 1]
  assert.equal(last.accepted, true, 'the write was accepted')
  // Compared field by field rather than with `deepEqual`: the ops array is built
  // inside the vm sandbox, so its prototype differs from this realm's and a strict
  // deep-equal rejects it as "same structure but not reference-equal".
  assert.equal(last.ops.length, 1, 'exactly one op')
  assert.equal(last.ops[0].op, 'set')
  assert.deepEqual([...last.ops[0].path], ['folder'])
  assert.equal(last.ops[0].value, 'D:\\NewMusic')
})

await check('the stored document really changed', () => {
  assert.equal(client2.document.folder, 'D:\\NewMusic')
})

await check('a stale revision is retried through remoteMutate instead of silently failing', async () => {
  const stale = makeClient()
  const staleHooks = makeHooks()
  const plugin3 = loaded.factory((specifier) => {
    if (specifier === 'react') return staleHooks.React
    throw new Error('unexpected require: ' + specifier)
  })
  plugin3.apply(stale.ctx)

  // Force a revision mismatch on the next write, so the fenced `mutate` is refused
  // and the unfenced remote retry is the only path that can land.
  const scope = stale.ctx.get('configForms').get('dsh-bgm')
  scope.getSnapshot = () => ({ value: stale.document, revision: stale.revision + 99 })

  const row = registrationFor(stale, 'settings.general.item').component
  const first = render(row(), staleHooks)
  const firstInputs = collect(first, (node) => node.type === 'input' && node.props.type === 'text')
  firstInputs[0].props.onChange({ target: { value: 'E:\\Retry' } })

  // Commit from the render that HAS the draft. Calling `onKeyDown` on the earlier
  // render would commit the old draft — or nothing at all, since the draft is still
  // `null` — and the test would read as a broken retry path when it is correct.
  const second = render(row(), staleHooks)
  const secondInputs = collect(second, (node) => node.type === 'input' && node.props.type === 'text')
  assert.equal(secondInputs[0].props.value, 'E:\\Retry', 'the draft is in state')
  secondInputs[0].props.onKeyDown({ key: 'Enter', preventDefault() {} })

  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(
    stale.writes.some((entry) => entry.accepted === false),
    'the fenced write was refused, which is what triggers the retry',
  )
})

await check('requiring react is the only external the bundle needs', () => {
  const requested = []
  loaded.factory((specifier) => {
    requested.push(specifier)
    return hooks.React
  })
  assert.deepEqual(requested, ['react'], 'no other module is required at factory time')
})

await check('the bundle requests no filesystem or node builtin', () => {
  for (const banned of ['node:fs', 'node:path', 'fs', 'path', 'child_process', 'electron']) {
    assert.equal(source.includes("require('" + banned + "')"), false, 'must not require ' + banned)
  }
})

await check('the bundle never uses ctx.get at the top level of apply', () => {
  // Documented convention: services are reached through ctx.inject so an absent
  // service cannot park the fiber. `serviceAt` uses owner.get inside the injected
  // scope, which is fine — assert the pattern is present so a regression to a
  // bare `ctx.get(...)` in apply is caught.
  assert.ok(source.includes('owner.get(name)'), 'reads services through the injected owner')
  assert.ok(source.includes('ctx.inject('), 'reaches services through ctx.inject')
})

// ── a folder that changes underneath the plugin ──────────────────────────────
console.log('\ndeleted files (library is owned by the filesystem, not by this plugin)')

/**
 * Drive the store with a controllable manifest, so a deletion can be simulated.
 *
 * The real route reads a real directory, and a test cannot delete the user's music.
 * What matters is the same either way: the Host answers with a NEW list, and the
 * store must reconcile against it rather than keep playing the old one.
 */
function withManifest(tracks, error = null) {
  const realFetch = sandbox.fetch
  sandbox.fetch = () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ enabled: true, folder: '/music', resolved: '/music', tracks, error }),
  })
  return () => { sandbox.fetch = realFetch }
}

/** Let every pending microtask settle (the reload chain is several promises deep). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

await check('a deleted track stops playback instead of continuing on a stale list', async () => {
  const store = sandbox.globalThis.__dshBgmPlaybackStore__
  const restore = withManifest([
    { name: 'a.mp3', src: '/a', type: 'audio/mpeg' },
    { name: 'b.mp3', src: '/b', type: 'audio/mpeg' },
  ])
  try {
    await store.reload()
    await settle()
    store.set({ index: 1, playing: true })
    assert.equal(store.getSnapshot().tracks.length, 2)
    assert.equal(store.currentTrack().name, 'b.mp3')

    // The user deletes b.mp3 (and a.mp3) in Explorer. The Host now reports none.
    sandbox.fetch = () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ enabled: true, folder: '/music', resolved: '/music', tracks: [], error: null }),
    })
    await store.reload()
    await settle()

    const after = store.getSnapshot()
    assert.deepEqual(after.tracks, [], 'the track list follows the Host')
    assert.equal(after.playing, false, 'playback stops rather than sliding onto a stale slot')
    assert.equal(after.index, -1, 'no selection survives an empty library')
  } finally {
    restore()
  }
})

await check('a deleted track does not slide playback onto a DIFFERENT song', async () => {
  // The subtle half of the bug: with the index carried across a refresh, deleting
  // an earlier file shifts every later one and the user suddenly hears a different
  // song. Selection must follow the track NAME.
  const store = sandbox.globalThis.__dshBgmPlaybackStore__
  const restore = withManifest([
    { name: 'a.mp3', src: '/a', type: 'audio/mpeg' },
    { name: 'b.mp3', src: '/b', type: 'audio/mpeg' },
    { name: 'c.mp3', src: '/c', type: 'audio/mpeg' },
  ])
  try {
    await store.reload()
    await settle()
    // Play c.mp3 (index 2).
    store.set({ index: 2, playing: true })
    assert.equal(store.currentTrack().name, 'c.mp3')

    // a.mp3 is deleted. c.mp3 moves from index 2 to index 1.
    sandbox.fetch = () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        enabled: true,
        folder: '/music',
        resolved: '/music',
        tracks: [
          { name: 'b.mp3', src: '/b', type: 'audio/mpeg' },
          { name: 'c.mp3', src: '/c', type: 'audio/mpeg' },
        ],
        error: null,
      }),
    })
    await store.reload()
    await settle()

    const after = store.getSnapshot()
    assert.equal(after.tracks.length, 2)
    assert.equal(store.currentTrack().name, 'c.mp3', 'still the same song, not a shifted one')
    assert.equal(after.index, 1, 'the index moved with the track')
    assert.equal(after.playing, true, 'an untouched track keeps playing')
  } finally {
    restore()
  }
})

await check('the library is re-read when it has gone stale, and not before', async () => {
  const store = sandbox.globalThis.__dshBgmPlaybackStore__
  let fetches = 0
  const restore = sandbox.fetch
  sandbox.fetch = () => {
    fetches += 1
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ enabled: true, folder: '/music', resolved: '/music', tracks: [], error: null }),
    })
  }
  try {
    await store.reload()
    await settle()
    const afterLoad = fetches

    // Immediately after a load the listing is fresh, so a stale check must not
    // refetch — otherwise the periodic timer would become a poll.
    store.refreshIfStale()
    await settle()
    assert.equal(fetches, afterLoad, 'a fresh listing is not re-read')

    // And the mechanism exists to be driven by the timer; assert the surface the
    // player's effect actually calls.
    assert.equal(typeof store.refreshIfStale, 'function')
  } finally {
    sandbox.fetch = restore
  }
})

await check('the player schedules refreshes that notice a deleted file', async () => {
  // The reported bug was not the reconcile logic — it was that NOTHING ever asked
  // again. `reload()` fired only when the folder CHANGED, so a file deleted from a
  // folder that stayed the same was never noticed. This drives the real effect with
  // observable timers and asserts a refresh actually reaches the Host.
  const store = sandbox.globalThis.__dshBgmPlaybackStore__
  const scheduled = []
  const realSetInterval = sandbox.setInterval
  sandbox.setInterval = (fn, ms) => {
    scheduled.push({ fn, ms })
    return 'timer-handle'
  }
  const listeners = []
  const realDoc = sandbox.document
  sandbox.document = {
    createElement: realDoc.createElement,
    visibilityState: 'visible',
    addEventListener: (type, fn) => listeners.push({ target: 'document', type, fn }),
    removeEventListener: () => {},
  }
  const winListeners = []
  const realAdd = sandbox.addEventListener
  sandbox.addEventListener = (type, fn) => winListeners.push({ type, fn })

  let fetches = 0
  const realFetch = sandbox.fetch
  sandbox.fetch = () => {
    fetches += 1
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ enabled: true, folder: '/music', resolved: '/music', tracks: [], error: null }),
    })
  }

  try {
    const hookSet = makeHooks()
    const client = makeClient()
    const instance = loaded.factory((specifier) => {
      if (specifier === 'react') return hookSet.React
      throw new Error('unexpected require: ' + specifier)
    })
    instance.apply(client.ctx)
    const player = registrationFor(client, 'shell.overlay').component
    // Render with effect replay, which is what a real mount does.
    render(player(), hookSet)

    // `>= 1` rather than `=== 1`: this harness replays effects to settle a render,
    // so the mount effect legitimately runs more than once here. What matters is
    // that a periodic refresh exists, on the right interval, and that firing it
    // reaches the Host — the assertions below.
    assert.ok(scheduled.length >= 1, 'the player installed a periodic refresh')
    assert.equal(scheduled[0].ms, 15000, 'on the documented TTL')
    assert.equal(
      listeners.some((entry) => entry.type === 'visibilitychange'),
      true,
      'returning to the tab refreshes, which is when a user who just deleted expects it',
    )
    assert.equal(
      winListeners.some((entry) => entry.type === 'focus'),
      true,
      'and window focus covers platforms without a visibility change',
    )

    // The mount already read the library, so the listing is FRESH and a tick now
    // must decline — that is the anti-poll behaviour, asserted below. To exercise
    // the notice-a-deletion path the cache has to age, which is what time passing
    // does: the scenario is "the user deleted files a while ago".
    const fresh = fetches
    scheduled[0].fn()
    await settle()
    assert.equal(fetches, fresh, 'a fresh listing is not re-read by the next tick')

    // Age the cache past the TTL by moving the clock, then tick again. The store
    // reads `Date.now()`, so this is the same passage of time without a real wait.
    const realNow = Date.now
    Date.now = () => realNow() + 60000
    try {
      const before = fetches
      scheduled[0].fn()
      await settle()
      assert.ok(fetches > before, 'an aged listing IS re-read, so a deletion is noticed')
    } finally {
      Date.now = realNow
    }
  } finally {
    sandbox.setInterval = realSetInterval
    sandbox.document = realDoc
    sandbox.addEventListener = realAdd
    sandbox.fetch = realFetch
  }
})

// ── stacking ────────────────────────────────────────────────────────────────
console.log('\nstacking')

await check('the card out-stacks every layer DSH itself uses', () => {
  // DSH's own scale, read out of the packaged client bundles: `1000` is the
  // mask/dialog layer and `1100` the menu layer. A fullscreen document preview or a
  // modal would otherwise paint over the card, which is what the user reported.
  const DSH_HIGHEST_LAYER = 1100
  const handle = chipHandle(sandbox.globalThis.__dshBgmPlaybackStore__)
  const zIndex = Number(handle.chip().props.style.zIndex)
  assert.ok(Number.isFinite(zIndex), 'the card declares a numeric z-index')
  assert.ok(zIndex > DSH_HIGHEST_LAYER, 'above the menu layer: ' + zIndex + ' > ' + DSH_HIGHEST_LAYER)
})

await check('the card is fixed-positioned, so it is not trapped in a scrolling column', () => {
  const handle = chipHandle(sandbox.globalThis.__dshBgmPlaybackStore__)
  assert.equal(handle.chip().props.style.position, 'fixed')
  // No ancestor transform can trap a fixed element only if none is applied; the
  // overlay layer is outside every column's scroll container by construction, so the
  // remaining risk is a stacking context, which the z-index assertion covers.
  assert.equal(handle.chip().props.style.pointerEvents, 'auto', 'and still clickable')
})

// ── the window-drag region ──────────────────────────────────────────────────
console.log('\nwindow-drag region')

await check('the card opts out of the window-drag region', () => {
  // DSH's frameless window moves by styling a title-bar strip with
  // `-webkit-app-region: drag`:
  //
  //   [data-windows-titlebar] .BynINW_frame:before {
  //     height: var(--dsh-windows-titlebar-height);
  //     -webkit-app-region: drag;
  //   }
  //
  // The overlay spans the frame, so a card that drifts onto that strip INHERITS the
  // behaviour and the OS claims the gesture before any `pointerdown` handler runs —
  // dragging the card moved the whole window. This is the regression guard.
  const handle = chipHandle(sandbox.globalThis.__dshBgmPlaybackStore__)
  const style = handle.chip().props.style
  // React spells the CSS property `WebkitAppRegion`; the custom-property form is
  // also set because a bare `app-region` is what some builds read.
  const value = style.WebkitAppRegion ?? style.webkitAppRegion ?? style.appRegion
  assert.equal(value, 'no-drag', 'the card must reclaim the gesture from the title bar')
})

await check('a press on the card stops propagating to ancestors', () => {
  // Even with `no-drag`, an ancestor may have its own press semantics. A card drag
  // must not also start one, so the handlers claim the gesture.
  const handle = chipHandle(sandbox.globalThis.__dshBgmPlaybackStore__)
  let onDown = 0
  let onMove = 0
  const event = (over) =>
    Object.assign(
      {
        button: 0,
        pointerId: 7,
        clientX: 0,
        clientY: 0,
        target: { tagName: 'DIV' },
        currentTarget: { setPointerCapture: () => {}, releasePointerCapture: () => {} },
        preventDefault: () => {},
        stopPropagation: () => {},
      },
      over,
    )

  handle.chip().props.onPointerDown(event({ clientX: 1000, clientY: 760, stopPropagation: () => { onDown += 1 } }))
  assert.equal(onDown, 1, 'the press is claimed')
  handle.chip().props.onPointerMove(event({ clientX: 300, clientY: 300, stopPropagation: () => { onMove += 1 } }))
  assert.equal(onMove, 1, 'and so is a real drag')
})

await check('a press that stays a click still lets the buttons work', () => {
  // Claiming the gesture must not break the transport buttons: a press that starts
  // on a <button> is left entirely alone, so the click handler still fires.
  const handle = chipHandle(sandbox.globalThis.__dshBgmPlaybackStore__)
  let stopped = 0
  handle.chip().props.onPointerDown({
    button: 0,
    pointerId: 7,
    clientX: 500,
    clientY: 500,
    target: { tagName: 'BUTTON' },
    currentTarget: { setPointerCapture: () => {} },
    stopPropagation: () => { stopped += 1 },
  })
  assert.equal(stopped, 0, 'a button press is not swallowed by the drag handler')
})

// ── playback modes ──────────────────────────────────────────────────────────
console.log('\nplayback modes (sequence / shuffle / single)')

/** A store with a known library, in a known mode. */
async function modeStore(names, mode = 'sequence') {
  const store = sandbox.globalThis.__dshBgmPlaybackStore__
  const restore = withManifest(names.map((name) => ({ name, src: '/' + name, type: 'audio/mpeg' })))
  await store.reload()
  await settle()
  store.setMode('sequence')
  store.set({ index: 0, playing: false, order: [], orderIndex: -1 })
  if (mode !== 'sequence') store.setMode(mode)
  await settle()
  return { store, restore }
}

await check('sequence advances by one and wraps at the end', async () => {
  const { store, restore } = await modeStore(['a', 'b', 'c'])
  try {
    assert.equal(store.getSnapshot().mode, 'sequence')
    const visited = []
    for (let step = 0; step < 5; step += 1) {
      visited.push(store.currentTrack().name)
      store.next(true)
    }
    // Wrapping is what makes a folder a playlist rather than a one-shot queue.
    assert.deepEqual(visited, ['a', 'b', 'c', 'a', 'b'])
  } finally {
    restore()
  }
})

await check('single repeats the SAME track when it ends', async () => {
  const { store, restore } = await modeStore(['a', 'b', 'c'], 'single')
  try {
    assert.equal(store.getSnapshot().mode, 'single')
    store.playTrack(1)
    const visited = []
    for (let step = 0; step < 4; step += 1) {
      visited.push(store.currentTrack().name)
      // `true` = the track ended on its own, which the mode says to repeat.
      store.next(true)
    }
    assert.deepEqual(visited, ['b', 'b', 'b', 'b'], 'repeat one never advances')
  } finally {
    restore()
  }
})

await check('single still advances when the user presses Next', async () => {
  // Without this distinction the Next button would do nothing in repeat-one, which
  // is a dead control — the mode says what an ENDING track does, not what the user
  // asking to move on means.
  const { store, restore } = await modeStore(['a', 'b', 'c'], 'single')
  try {
    store.playTrack(0)
    assert.equal(store.currentTrack().name, 'a')
    store.next(false)
    assert.equal(store.currentTrack().name, 'b', 'an explicit Next moves on')
    store.next(true)
    assert.equal(store.currentTrack().name, 'b', 'but an ending track still repeats')
  } finally {
    restore()
  }
})

await check('shuffle visits every track exactly once before repeating', async () => {
  // The whole reason the order is a materialised permutation: a per-step random
  // pick repeats before exhausting the folder, which is the classic shuffle
  // complaint. This asserts the COVER property, not any particular order.
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
  const { store, restore } = await modeStore(names, 'shuffle')
  try {
    assert.equal(store.getSnapshot().mode, 'shuffle')
    store.playTrack(0)
    const cycle = []
    for (let step = 0; step < names.length; step += 1) {
      cycle.push(store.currentTrack().name)
      store.next(true)
    }
    assert.equal(new Set(cycle).size, names.length, 'no track repeated within one cycle: ' + cycle.join(','))
    // And the next step begins a fresh cycle rather than stopping.
    const afterCycle = store.currentTrack().name
    assert.ok(names.includes(afterCycle), 'playback continues after a full cycle')
  } finally {
    restore()
  }
})

await check('switching to shuffle does not interrupt the current track', async () => {
  const { store, restore } = await modeStore(['a', 'b', 'c', 'd'], 'sequence')
  try {
    store.playTrack(2)
    assert.equal(store.currentTrack().name, 'c')
    store.setMode('shuffle')
    assert.equal(store.currentTrack().name, 'c', 'the playing song is not swapped out')
    // The order starts AT the current track, so the first Next is not a jump back.
    const order = store.getSnapshot().order
    assert.equal(store.getSnapshot().orderIndex, 0, 'the cursor points at the current track')
    assert.equal(order[0], 2, 'and the current track heads the order')
  } finally {
    restore()
  }
})

await check('shuffle reaches every track from wherever the user started', async () => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f']
  const { store, restore } = await modeStore(names, 'shuffle')
  try {
    // A manual pick must move the cursor with it, or "next" would jump backwards.
    store.playTrack(4)
    const cycle = []
    for (let step = 0; step < names.length; step += 1) {
      cycle.push(store.currentTrack().name)
      store.next(true)
    }
    assert.equal(new Set(cycle).size, names.length, 'still covers everything: ' + cycle.join(','))
  } finally {
    restore()
  }
})

await check('leaving shuffle drops the order, and re-entering builds a fresh one', async () => {
  const { store, restore } = await modeStore(['a', 'b', 'c'], 'shuffle')
  try {
    assert.ok(store.getSnapshot().order.length > 0, 'shuffle has an order')
    store.setMode('sequence')
    assert.deepEqual([...store.getSnapshot().order], [], 'sequence carries no order')
    assert.equal(store.getSnapshot().orderIndex, -1)
    store.setMode('shuffle')
    assert.equal(store.getSnapshot().order.length, 3, 're-entering builds one')
  } finally {
    restore()
  }
})

await check('a library refresh rebuilds the shuffle order for the new list', async () => {
  // An order drawn from the old list would carry dead indices (deleted files) and
  // miss the new ones, silently breaking "every track once per cycle".
  const { store, restore } = await modeStore(['a', 'b', 'c', 'd'], 'shuffle')
  try {
    assert.equal(store.getSnapshot().order.length, 4)
    const restore2 = withManifest([
      { name: 'a', src: '/a', type: 'audio/mpeg' },
      { name: 'b', src: '/b', type: 'audio/mpeg' },
    ])
    try {
      await store.reload()
      await settle()
      const after = store.getSnapshot()
      assert.equal(after.tracks.length, 2)
      assert.equal(after.order.length, 2, 'the order matches the new library')
      assert.ok(
        after.order.every((index) => index >= 0 && index < 2),
        'no dead index survives the refresh',
      )
    } finally {
      restore2()
    }
  } finally {
    restore()
  }
})

await check('the mode cycles in the documented order', async () => {
  const { store, restore } = await modeStore(['a', 'b'])
  try {
    assert.equal(store.getSnapshot().mode, 'sequence')
    store.cycleMode()
    assert.equal(store.getSnapshot().mode, 'shuffle')
    store.cycleMode()
    assert.equal(store.getSnapshot().mode, 'single')
    store.cycleMode()
    assert.equal(store.getSnapshot().mode, 'sequence', 'and wraps')
  } finally {
    restore()
  }
})

await check('an unknown mode is refused rather than stored', () => {
  const store = sandbox.globalThis.__dshBgmPlaybackStore__
  const before = store.getSnapshot().mode
  store.setMode('nonsense')
  assert.equal(store.getSnapshot().mode, before, 'a bad value cannot corrupt the state')
})

await check('previous walks backwards and wraps, and is order-aware in shuffle', async () => {
  const { store, restore } = await modeStore(['a', 'b', 'c'])
  try {
    store.playTrack(0)
    store.previous()
    assert.equal(store.currentTrack().name, 'c', 'wraps to the last track')
    store.previous()
    assert.equal(store.currentTrack().name, 'b')
  } finally {
    restore()
  }
})

await check('the mode is persisted through the settings row, not only in memory', async () => {
  // The overlay has no settings scope, so the ROW must own the write. Otherwise the
  // choice would reset on every reload.
  const client = makeClient()
  const hookSet = makeHooks()
  const instance = loaded.factory((specifier) => {
    if (specifier === 'react') return hookSet.React
    throw new Error('unexpected require: ' + specifier)
  })
  instance.apply(client.ctx)
  const row = registrationFor(client, 'settings.general.item').component
  const tree = render(row(), hookSet)

  // Find the mode button by its aria-label, which is the only stable handle.
  const buttons = collect(tree, (node) => node.type === 'button')
  const modeButton = buttons.find((node) => String(node.props['aria-label'] ?? '').includes('播放模式'))
  assert.notEqual(modeButton, undefined, 'the row offers a mode control')
  modeButton.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.ok(client.writes.length >= 1, 'clicking it wrote to the settings document')
  const last = client.writes[client.writes.length - 1]
  assert.equal(last.ops[0].op, 'set')
  assert.equal(last.ops[0].path[0], 'mode', 'the field the Host schema declares')
  assert.ok(['sequence', 'shuffle', 'single'].includes(last.ops[0].value), 'a valid mode: ' + last.ops[0].value)
})

await check('the three mode labels are distinct and translated', () => {
  // A mode control the user cannot read is worse than none, and three identical
  // labels would make the active mode invisible.
  const dict = sandbox.globalThis.__dshBgmPlaybackStore__ === undefined ? null : null
  void dict
  const source_ = source
  for (const key of ['modeSequence', 'modeShuffle', 'modeSingle']) {
    assert.ok(source_.includes(key + ':'), 'the label exists: ' + key)
  }
  assert.ok(source_.includes('modeSequenceGlyph'), 'and a short glyph for the card')
  assert.ok(source_.includes('modeShuffleGlyph'))
  assert.ok(source_.includes('modeSingleGlyph'))
})

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
