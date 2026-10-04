/**
 * Logic smoke test for the Host half of dsh-bgm.
 *
 * The Host half is the half that touches the filesystem and the network, so it is
 * the half worth testing without a browser. Everything here runs the plugin's own
 * exported functions against a real temporary library, and drives the two routes
 * through a fake `webServer` to prove they answer with real bytes and real range
 * semantics.
 *
 * Run: node _smoke/logic-smoke.mjs
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { Readable, Writable } from 'node:stream'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

// The plugin's `index.js` imports `@deepseek-ai/schemastery` with a bare specifier.
// That is a PEER dependency supplied by the DSH host, so a fresh clone has no copy
// on its own resolution path and the import below would fail. The hook answers that
// one specifier from wherever DSH actually keeps the library. Registered before the
// dynamic import so it is in place in time.
register('./resolve-hook.mjs', pathToFileURL(import.meta.filename))

const { internals } = await import('../index.js')

const {
  ROUTE,
  audioType,
  resolveFolder,
  listTracks,
  resolveTrack,
  buildManifest,
  readField,
  DEFAULT_SETTINGS,
} = internals

let passed = 0
let failed = 0

function check(label, fn) {
  try {
    fn()
    passed += 1
    console.log('  ok   ' + label)
  } catch (error) {
    failed += 1
    console.log('  FAIL ' + label + '\n       ' + String(error && error.message ? error.message : error))
  }
}

async function checkAsync(label, fn) {
  try {
    await fn()
    passed += 1
    console.log('  ok   ' + label)
  } catch (error) {
    failed += 1
    console.log('  FAIL ' + label + '\n       ' + String(error && error.message ? error.message : error))
  }
}

console.log('dsh-bgm host smoke test\n')

// ── readField: both config shapes ────────────────────────────────────────────
console.log('readField')

check('plain snapshot value passes through', () => {
  assert.equal(readField({ folder: 'C:\\Music' }, 'folder'), 'C:\\Music')
})

check('volatile reference is read through get()', () => {
  const ref = { [Symbol.for('cosmokit.volatile.write')]: true, get: () => 'D:\\Tracks' }
  assert.equal(readField({ folder: ref }, 'folder'), 'D:\\Tracks')
})

check('absent field stays undefined', () => {
  assert.equal(readField(undefined, 'folder'), undefined)
  assert.equal(readField({}, 'volume'), undefined)
})

check('defaults are the documented ones', () => {
  assert.equal(DEFAULT_SETTINGS.folder, '')
  assert.equal(DEFAULT_SETTINGS.enabled, true)
  assert.equal(DEFAULT_SETTINGS.volume, 0.5)
})

// ── audioType: the whitelist ─────────────────────────────────────────────────
console.log('\naudioType')

check('known containers map to their MIME types', () => {
  assert.equal(audioType('song.mp3'), 'audio/mpeg')
  assert.equal(audioType('song.MP3'), 'audio/mpeg', 'case-insensitive')
  assert.equal(audioType('song.flac'), 'audio/flac')
  assert.equal(audioType('song.wav'), 'audio/wav')
  assert.equal(audioType('song.m4a'), 'audio/mp4')
  assert.equal(audioType('song.ogg'), 'audio/ogg')
})

check('non-audio and extensionless names are refused', () => {
  assert.equal(audioType('readme.txt'), undefined)
  assert.equal(audioType('movie.mp4'), undefined)
  assert.equal(audioType('noextension'), undefined)
  assert.equal(audioType('evil.mp3.exe'), undefined)
})

// ── resolveTrack: the containment boundary ───────────────────────────────────
console.log('\nresolveTrack (traversal defence)')

const folder = join(tmpdir(), 'dsh-bgm-lib')

check('a plain name resolves inside the folder', () => {
  const hit = resolveTrack(ROUTE + '/track/song.mp3', folder)
  assert.notEqual(hit, undefined)
  assert.equal(hit.absolute, join(folder, 'song.mp3'))
  assert.equal(hit.type, 'audio/mpeg')
})

check('percent-encoded CJK names resolve (the workspace really has these)', () => {
  const hit = resolveTrack(ROUTE + '/track/' + encodeURIComponent('月色小调.mp3'), folder)
  assert.notEqual(hit, undefined)
  assert.equal(hit.absolute, join(folder, '月色小调.mp3'))
})

check('a query string is ignored', () => {
  const hit = resolveTrack(ROUTE + '/track/song.mp3?v=123', folder)
  assert.notEqual(hit, undefined)
  assert.equal(hit.absolute, join(folder, 'song.mp3'))
})

check('parent traversal is refused', () => {
  assert.equal(resolveTrack(ROUTE + '/track/..%2Fsecret.mp3', folder), undefined)
  assert.equal(resolveTrack(ROUTE + '/track/..%5Csecret.mp3', folder), undefined)
  assert.equal(resolveTrack(ROUTE + '/track/../secret.mp3', folder), undefined)
  assert.equal(resolveTrack(ROUTE + '/track/..', folder), undefined)
  assert.equal(resolveTrack(ROUTE + '/track/.', folder), undefined)
})

check('nested paths are refused', () => {
  assert.equal(resolveTrack(ROUTE + '/track/sub/song.mp3', folder), undefined)
  assert.equal(resolveTrack(ROUTE + '/track/sub%2Fsong.mp3', folder), undefined)
})

check('absolute-path smuggling is refused', () => {
  assert.equal(resolveTrack(ROUTE + '/track/C%3A%5CWindows%5Cx.mp3', folder), undefined)
})

check('NUL bytes and empty names are refused', () => {
  assert.equal(resolveTrack(ROUTE + '/track/%00.mp3', folder), undefined)
  assert.equal(resolveTrack(ROUTE + '/track/', folder), undefined)
  assert.equal(resolveTrack(ROUTE + '/track', folder), undefined)
})

check('malformed percent-encoding is refused, not thrown', () => {
  assert.equal(resolveTrack(ROUTE + '/track/%E0%A4%A.mp3', folder), undefined)
})

check('non-audio targets are refused even inside the folder', () => {
  assert.equal(resolveTrack(ROUTE + '/track/notes.txt', folder), undefined)
  assert.equal(resolveTrack(ROUTE + '/track/program.exe', folder), undefined)
})

check('a URL outside the track prefix is refused', () => {
  assert.equal(resolveTrack(ROUTE + '/manifest.json', folder), undefined)
  assert.equal(resolveTrack('/plugins/other/track/song.mp3', folder), undefined)
})

// ── resolveFolder + listTracks against a real directory ──────────────────────
console.log('\nresolveFolder / listTracks (real filesystem)')

const library = await mkdtemp(join(tmpdir(), 'dsh-bgm-'))
await writeFile(join(library, 'b-second.mp3'), Buffer.alloc(2048, 7))
await writeFile(join(library, 'a-first.wav'), Buffer.alloc(1024, 3))
await writeFile(join(library, '月色小调.mp3'), Buffer.alloc(3000, 9))
await writeFile(join(library, 'notes.txt'), 'not audio')
await writeFile(join(library, 'movie.mp4'), Buffer.alloc(64, 1))

await checkAsync('an existing directory resolves', async () => {
  assert.equal(await resolveFolder(library), library)
})

await checkAsync('an empty string is "unset", not an error', async () => {
  assert.equal(await resolveFolder(''), undefined)
  assert.equal(await resolveFolder('   '), undefined)
})

await checkAsync('a non-directory is refused', async () => {
  assert.equal(await resolveFolder(join(library, 'notes.txt')), undefined)
})

await checkAsync('a missing directory is refused', async () => {
  assert.equal(await resolveFolder(join(library, 'nope')), undefined)
})

await checkAsync('a non-string is refused', async () => {
  assert.equal(await resolveFolder(undefined), undefined)
  assert.equal(await resolveFolder(42), undefined)
})

await checkAsync('only audio files are listed, name-sorted', async () => {
  const tracks = await listTracks(library)
  assert.equal(tracks.length, 3, 'txt and mp4 excluded')
  // The order is the one `localeCompare(…, 'zh-Hans-CN')` actually produces, with
  // CJK collating ahead of Latin — asserted here as measured rather than as
  // assumed, because the sort is a UX choice and not a correctness claim.
  assert.deepEqual(
    tracks.map((track) => track.name),
    ['月色小调.mp3', 'a-first.wav', 'b-second.mp3'],
  )
  assert.deepEqual(
    tracks.slice(1).map((track) => track.type),
    ['audio/wav', 'audio/mpeg'],
  )
  assert.equal(tracks[0].type, 'audio/mpeg', 'extension decides the type, not the collation')
})

await checkAsync('CJK file names survive the round trip', async () => {
  const tracks = await listTracks(library)
  assert.ok(tracks.some((track) => track.name === '月色小调.mp3'))
})

// ── buildManifest: the three states the row must distinguish ─────────────────
console.log('\nbuildManifest')

await checkAsync('an unset folder reports FOLDER_UNSET with no tracks', async () => {
  const manifest = await buildManifest({ folder: '', enabled: true })
  assert.equal(manifest.error, 'FOLDER_UNSET')
  assert.equal(manifest.resolved, null)
  assert.deepEqual(manifest.tracks, [])
})

await checkAsync('an unusable folder reports FOLDER_UNUSABLE', async () => {
  const manifest = await buildManifest({ folder: join(library, 'nope'), enabled: true })
  assert.equal(manifest.error, 'FOLDER_UNUSABLE')
  assert.deepEqual(manifest.tracks, [])
})

await checkAsync('a good folder reports tracks with servable src URLs', async () => {
  const manifest = await buildManifest({ folder: library, enabled: true })
  assert.equal(manifest.error, null)
  assert.equal(manifest.resolved, library)
  assert.equal(manifest.tracks.length, 3)
  for (const track of manifest.tracks) {
    assert.ok(track.src.startsWith(ROUTE + '/track/'), 'src points at the byte route')
    // Every advertised src must actually resolve through the byte route's own
    // guard — otherwise the manifest would advertise files the route refuses.
    assert.notEqual(resolveTrack(track.src, library), undefined, 'src resolves: ' + track.name)
    assert.equal(track.src.includes('\\'), false, 'src is URL-shaped')
  }
})

await checkAsync('the enabled flag is carried through', async () => {
  const off = await buildManifest({ folder: library, enabled: false })
  assert.equal(off.enabled, false)
})

await checkAsync('manifest reads live volatile references', async () => {
  const ref = (value) => ({ [Symbol.for('cosmokit.volatile.write')]: true, get: () => value })
  const manifest = await buildManifest({ folder: ref(library), enabled: ref(true) })
  assert.equal(manifest.resolved, library)
  assert.equal(manifest.tracks.length, 3)
})

// ── the routes, driven through a fake webServer ──────────────────────────────
console.log('\nroutes (fake webServer + real HTTP semantics)')

const { apply } = await import('../index.js')

/**
 * A response recorder that is a real writable stream.
 *
 * It has to be one: the byte route hands the response to `stream.pipe(res)`, and
 * a hand-rolled object with a bare `end` would never receive the file bytes —
 * the assertions would then pass while proving nothing about what was streamed.
 * Being a `Writable` also gives the `HEAD` case its real semantics (headers, no
 * chunks) for free.
 */
function makeResponse() {
  const chunks = []
  const response = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
  })
  response.status = 0
  response.headers = {}
  response.headersSent = false
  response.chunks = chunks
  response.writeHead = function writeHead(status, headers) {
    response.status = status
    response.headers = headers || {}
    response.headersSent = true
    return response
  }
  /** Resolve once the response has fully drained (body streamed and ended). */
  response.settled = function settled() {
    return new Promise((resolve) => {
      if (response.writableEnded) {
        resolve()
        return
      }
      response.once('finish', resolve)
    })
  }
  return response
}

/** Collect a streamed body into one buffer. */
function collect(stream) {
  return new Promise((resolve, reject) => {
    const parts = []
    stream.on('data', (part) => parts.push(part))
    stream.on('end', () => resolve(Buffer.concat(parts)))
    stream.on('error', reject)
  })
}

/** Install the plugin against a stub server and capture its routes. */
function mount(config) {
  const routes = []
  const effects = []
  const warnings = []
  const ctx = {
    logger: {
      warn: (...args) => warnings.push(args.join(' ')),
      error: (...args) => warnings.push(args.join(' ')),
      info: () => {},
      debug: () => {},
    },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    inject: () => {},
    effect: (factory) => { effects.push(factory()) },
  }
  apply(ctx, config)
  return { routes, warnings, effects }
}

/**
 * Drive one route handler the way the web server would.
 *
 * The handlers are written as `void (async () => …)()` — they return immediately
 * and finish work asynchronously — so a test that merely calls `handler(...)` and
 * then reads the response races the plugin and observes status `0`. Awaiting the
 * response's own `finish` event is what actually waits for the work: for a JSON
 * answer that is the `end()`, and for a file it is the piped stream draining.
 *
 * @param route - the captured route.
 * @param request - url, method, headers.
 * @returns the response recorder, settled.
 */
async function drive(route, request) {
  const res = makeResponse()
  await route.handler(request, res)
  await res.settled()
  return res
}

/** Read a recorded JSON body. */
function body(res) {
  return JSON.parse(Buffer.concat(res.chunks).toString('utf8'))
}

const mounted = mount({ folder: library, enabled: true, volume: 0.5 })
const manifestRoute = () => mounted.routes.find((route) => route.path.endsWith('manifest.json'))
const trackRoute = () => mounted.routes.find((route) => route.path.endsWith('/track'))

await checkAsync('two routes are registered', async () => {
  assert.equal(mounted.routes.length, 2)
  const paths = mounted.routes.map((route) => route.path).sort()
  assert.deepEqual(paths, [ROUTE + '/manifest.json', ROUTE + '/track'])
})

await checkAsync('the byte route is a prefix and the manifest is exact', async () => {
  assert.equal(manifestRoute().kind, 'exact')
  assert.equal(trackRoute().kind, 'prefix', 'prefix so /track/<name> matches')
})

await checkAsync('no route claims the client bundle URL', async () => {
  // A prefix on ROUTE itself would swallow `/plugins/dsh-bgm/client.js` — the
  // bundle the browser fetches for THIS plugin — and the settings row would never
  // register. This is the regression that guard exists for.
  for (const route of mounted.routes) {
    assert.notEqual(route.path, ROUTE, 'no prefix on the bare route root')
    assert.equal(
      route.kind === 'prefix' && (ROUTE + '/client.js').startsWith(route.path),
      false,
      'client.js would be claimed by prefix ' + route.path,
    )
  }
})

await checkAsync('HEAD on a track answers headers and no body', async () => {
  const res = await drive(trackRoute(), { url: ROUTE + '/track/a-first.wav', method: 'HEAD', headers: {} })
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'audio/wav')
  assert.equal(res.headers['accept-ranges'], 'bytes')
  assert.equal(Number(res.headers['content-length']), 1024)
  assert.equal(res.chunks.length, 0, 'HEAD sends no body')
})

await checkAsync('a full GET streams the whole file', async () => {
  const res = await drive(trackRoute(), { url: ROUTE + '/track/a-first.wav', method: 'GET', headers: {} })
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'audio/wav')
  assert.equal(Number(res.headers['content-length']), 1024)
  const bytes = Buffer.concat(res.chunks)
  assert.equal(bytes.length, 1024, 'the whole file arrived')
  assert.ok(bytes.every((byte) => byte === 3), 'and it is the real payload')
  assert.equal(res.headers['accept-ranges'], 'bytes')
})

await checkAsync('a range request answers 206 with the exact slice', async () => {
  const res = await drive(trackRoute(), {
    url: ROUTE + '/track/a-first.wav',
    method: 'GET',
    headers: { range: 'bytes=0-99' },
  })
  assert.equal(res.status, 206)
  assert.equal(res.headers['content-range'], 'bytes 0-99/1024')
  assert.equal(Number(res.headers['content-length']), 100)
  const bytes = Buffer.concat(res.chunks)
  assert.equal(bytes.length, 100, 'exactly the requested slice')
  assert.ok(bytes.every((byte) => byte === 3))
})

await checkAsync('a mid-file range answers the right slice', async () => {
  const res = await drive(trackRoute(), {
    url: ROUTE + '/track/b-second.mp3',
    method: 'GET',
    headers: { range: 'bytes=1024-2047' },
  })
  assert.equal(res.status, 206)
  assert.equal(res.headers['content-range'], 'bytes 1024-2047/2048')
  assert.equal((await Promise.resolve(Buffer.concat(res.chunks))).length, 1024)
})

await checkAsync('an open-ended range runs to the end of the file', async () => {
  const res = await drive(trackRoute(), {
    url: ROUTE + '/track/b-second.mp3',
    method: 'GET',
    headers: { range: 'bytes=2044-' },
  })
  assert.equal(res.status, 206)
  assert.equal(res.headers['content-range'], 'bytes 2044-2047/2048')
  assert.equal(Buffer.concat(res.chunks).length, 4)
})

await checkAsync('a suffix range answers the last N bytes', async () => {
  const res = await drive(trackRoute(), {
    url: ROUTE + '/track/a-first.wav',
    method: 'GET',
    headers: { range: 'bytes=-64' },
  })
  assert.equal(res.status, 206)
  assert.equal(res.headers['content-range'], 'bytes 960-1023/1024')
  assert.equal(Buffer.concat(res.chunks).length, 64)
})

await checkAsync('an unsatisfiable range answers 416, not the whole file', async () => {
  const res = await drive(trackRoute(), {
    url: ROUTE + '/track/a-first.wav',
    method: 'GET',
    headers: { range: 'bytes=99999-' },
  })
  assert.equal(res.status, 416)
  assert.equal(res.headers['content-range'], 'bytes */1024')
  assert.equal(res.chunks.length, 0, 'no body on 416')
})

await checkAsync('a malformed range answers 416 rather than the whole file', async () => {
  const res = await drive(trackRoute(), {
    url: ROUTE + '/track/a-first.wav',
    method: 'GET',
    headers: { range: 'bytes=abc' },
  })
  assert.equal(res.status, 416)
  assert.equal(res.chunks.length, 0)
})

await checkAsync('an inverted range answers 416', async () => {
  const res = await drive(trackRoute(), {
    url: ROUTE + '/track/a-first.wav',
    method: 'GET',
    headers: { range: 'bytes=500-100' },
  })
  assert.equal(res.status, 416)
})

await checkAsync('a traversal attempt answers 404', async () => {
  const res = await drive(trackRoute(), {
    url: ROUTE + '/track/..%2F..%2Fsecret.mp3',
    method: 'GET',
    headers: {},
  })
  assert.equal(res.status, 404)
  assert.ok(Buffer.concat(res.chunks).toString().includes('not found'))
})

await checkAsync('a non-audio file answers 404', async () => {
  const res = await drive(trackRoute(), { url: ROUTE + '/track/notes.txt', method: 'GET', headers: {} })
  assert.equal(res.status, 404)
})

await checkAsync('a CJK track streams through the route', async () => {
  const res = await drive(trackRoute(), {
    url: ROUTE + '/track/' + encodeURIComponent('月色小调.mp3'),
    method: 'GET',
    headers: {},
  })
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'audio/mpeg')
  assert.equal(Number(res.headers['content-length']), 3000)
  assert.equal(Buffer.concat(res.chunks).length, 3000)
})

await checkAsync('the manifest route answers the library as JSON', async () => {
  const res = await drive(manifestRoute(), { url: ROUTE + '/manifest.json', method: 'GET', headers: {} })
  assert.equal(res.status, 200)
  assert.ok(String(res.headers['content-type']).startsWith('application/json'))
  assert.equal(res.headers['cache-control'], 'no-store', 'a live setting must not be cached')
  const payload = body(res)
  assert.equal(payload.tracks.length, 3)
  assert.equal(payload.error, null)
})

await checkAsync('every advertised track really streams through the byte route', async () => {
  // The manifest and the byte route are two independent guards. A src the byte
  // route refuses would be a track the UI offers and can never play, so each one
  // is followed end to end.
  const payload = body(await drive(manifestRoute(), { url: ROUTE + '/manifest.json', method: 'GET', headers: {} }))
  for (const advertised of payload.tracks) {
    const res = await drive(trackRoute(), { url: advertised.src, method: 'GET', headers: {} })
    assert.equal(res.status, 200, 'streams: ' + advertised.name)
    assert.equal(res.headers['content-type'], advertised.type, 'type matches: ' + advertised.name)
    assert.ok(Buffer.concat(res.chunks).length > 0, 'has bytes: ' + advertised.name)
  }
})

await checkAsync('the manifest follows a changed folder without a remount', async () => {
  const mutable = { folder: library, enabled: true }
  const remounted = mount(mutable)
  const route = remounted.routes.find((entry) => entry.path.endsWith('manifest.json'))
  const first = body(await drive(route, { url: ROUTE + '/manifest.json', method: 'GET', headers: {} }))
  assert.equal(first.tracks.length, 3)

  // Point it at an empty directory: the same live route must answer differently,
  // which is what proves the setting is read per request rather than captured.
  const empty = await mkdtemp(join(tmpdir(), 'dsh-bgm-empty-'))
  mutable.folder = empty
  const second = body(await drive(route, { url: ROUTE + '/manifest.json', method: 'GET', headers: {} }))
  assert.equal(second.tracks.length, 0)
  assert.equal(second.resolved, empty)
  await rm(empty, { recursive: true, force: true })
})

await checkAsync('a disabled config still serves the manifest, marked off', async () => {
  const off = mount({ folder: library, enabled: false })
  const res = await drive(off.routes.find((entry) => entry.path.endsWith('manifest.json')), {
    url: ROUTE + '/manifest.json',
    method: 'GET',
    headers: {},
  })
  const payload = body(res)
  assert.equal(payload.enabled, false)
  assert.equal(payload.tracks.length, 3, 'the library is still listed for the row to show')
})

await checkAsync('a broken library answers 200 with an empty list, never a throw', async () => {
  const broken = mount({ folder: join(library, 'gone'), enabled: true })
  const res = await drive(broken.routes.find((entry) => entry.path.endsWith('manifest.json')), {
    url: ROUTE + '/manifest.json',
    method: 'GET',
    headers: {},
  })
  assert.equal(res.status, 200, 'the row must render, not fail')
  assert.equal(body(res).error, 'FOLDER_UNUSABLE')

  const trackRes = await drive(broken.routes.find((entry) => entry.path.endsWith('/track')), {
    url: ROUTE + '/track/a-first.wav',
    method: 'GET',
    headers: {},
  })
  assert.equal(trackRes.status, 404)
})

await checkAsync('an unset folder answers 200 with FOLDER_UNSET', async () => {
  const unset = mount({ folder: '', enabled: true })
  const res = await drive(unset.routes.find((entry) => entry.path.endsWith('manifest.json')), {
    url: ROUTE + '/manifest.json',
    method: 'GET',
    headers: {},
  })
  assert.equal(res.status, 200)
  assert.equal(body(res).error, 'FOLDER_UNSET')
})

await checkAsync('a volatile config reads live through the routes', async () => {
  const pin = (value) => ({ [Symbol.for('cosmokit.volatile.write')]: true, get: () => value })
  const live = mount({ folder: pin(library), enabled: pin(true) })
  const res = await drive(live.routes.find((entry) => entry.path.endsWith('manifest.json')), {
    url: ROUTE + '/manifest.json',
    method: 'GET',
    headers: {},
  })
  assert.equal(body(res).tracks.length, 3)
})

await checkAsync('the plugin declares the schema, name and inject contract', async () => {
  const module = await import('../index.js')
  assert.equal(module.name, 'dsh-bgm', 'name matches the patch id and the settings namespace')
  assert.deepEqual(module.inject, ['webServer'])
  assert.equal(typeof module.apply, 'function')
  assert.notEqual(module.Config, undefined, 'Config must be a real export for dsh-settings to project it')

  // Every field has to be volatile, or dsh-settings projects an empty form,
  // describe() drops the entry, and the General-page row never mounts. This is
  // the single failure mode that looks like "the plugin loaded but nothing shows".
  const projected = typeof module.Config.toJSON === 'function' ? module.Config.toJSON() : module.Config
  const refs = projected.refs ?? {}
  const root = refs[String(projected.uid)] ?? projected
  const properties = root.dict ?? root.properties ?? {}
  const fields = ['folder', 'enabled', 'volume']
  for (const field of fields) {
    const node = properties[field]
    const resolved = typeof node === 'number' ? refs[String(node)] : node
    assert.notEqual(resolved, undefined, 'field declared: ' + field)
    assert.equal(resolved.meta?.volatile, true, field + ' must be volatile')
  }
})
// ── cleanup ──────────────────────────────────────────────────────────────────
await rm(library, { recursive: true, force: true })

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
