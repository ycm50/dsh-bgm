/**
 * Host half of `dsh-bgm` — the music-folder plugin.
 *
 * Two jobs, and only the second one needs to run in the Host process:
 *
 * 1. **The setting is declared here.** Under DSH 0.2.0-rc.2 a settings namespace
 *    is no longer `settings.register(ns, schema)`; a namespace IS a plugin entry,
 *    and `@deepseek-ai/dsh-settings` describes every running entry whose resolved
 *    module namespace carries a `Config` schema. That is why `Config` below is a
 *    real `export` and why it must resolve at module-evaluation time — a lazy
 *    import degrades to "no settings row" and a missing schema package takes the
 *    whole module down with it. `@deepseek-ai/schemastery` is therefore a peer
 *    dependency supplied by the host, never a vendored copy.
 *
 * 2. **The audio bytes have to be served.** A browser `<audio>` element cannot
 *    read an arbitrary `file://` path from a page served over HTTP, and the
 *    folder lives outside the served web root. So this half exposes the chosen
 *    directory over the existing `webServer` carrier: one manifest route listing
 *    the playable files and one byte route that streams a single track, Range
 *    requests included (seeking and long tracks both need them).
 *
 * Nothing in DSH itself is modified. The General-settings row the user sees is a
 * client-side slot registration (`client.js` → `settings.general.item`), which the
 * native settings page composes additively.
 *
 * @module dsh-bgm
 */

import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import z from '@deepseek-ai/schemastery'

/**
 * Whether the resolved schemastery can mark a Config field live-editable.
 *
 * `.volatile()` is what makes `dsh-settings` project a field into the form the
 * settings page renders: `volatileForm()` keeps only fields with `meta.volatile`,
 * and `describe()` drops every entry whose projected form is empty — an entry
 * with no volatile field is invisible, `whileServed` never fires, and the browser
 * row never mounts. Write-side is the same rule: the settings service refuses a
 * write to a non-volatile path outright.
 *
 * The method is probed rather than assumed because an older copy of the library
 * linked next to a workspace checkout does not have it, and calling it there
 * would throw while this module is being evaluated — taking the audio routes down
 * with the settings row. Degrading keeps the plugin functional, just without a
 * settings row, and `apply` says so in the log.
 */
const LIVE_CAPABLE = typeof z.boolean().volatile === 'function'

/** Mark one Config field live-editable, where the schema library allows it. */
function live(schema) {
  return LIVE_CAPABLE ? schema.volatile() : schema
}

/**
 * The key cosmokit puts on a live config reference.
 *
 * `.volatile()` does not yield the value: it yields a stable reference whose
 * `get()` answers the current immutable snapshot, identified across ESM/CJS
 * copies of the library by this global-registry symbol rather than by identity.
 * Only a volatile value changing lets `@deepseek-ai/cordis-plugin-loader` commit
 * the new snapshot into the SAME reference and emit `loader/volatile-update`
 * instead of restarting the fiber — which is exactly what makes an edit in the
 * settings page take effect on the next request with no restart.
 */
const VOLATILE_REF = Symbol.for('cosmokit.volatile.write')

/** Whether a config value is a live reference rather than a plain snapshot. */
function isLive(value) {
  return typeof value === 'object' && value !== null && VOLATILE_REF in value
}

/**
 * Read one applied-config field.
 *
 * A field declared volatile arrives as a live reference and must be read through
 * `get()`; a field whose schema never resolved arrives as a plain value. Both
 * shapes are handled, matching how the shipped Host plugins read config.
 *
 * @param config - the applied config, possibly undefined.
 * @param key - field name.
 * @returns the current value, or undefined when the field is absent.
 */
function readField(config, key) {
  const value = config?.[key]
  return isLive(value) && typeof value.get === 'function' ? value.get() : value
}

/** Values this plugin runs with when the applied config carries none. */
const DEFAULT_SETTINGS = {
  /** Absolute path of the folder to read music from. Empty disables playback. */
  folder: '',
  /** Master switch. Off serves nothing and the row plays nothing. */
  enabled: true,
  /** Playback volume, 0..1. */
  volume: 0.5,
  /** How the next track is chosen. Mirrors the browser half's default. */
  mode: 'sequence',
}

/**
 * Playback modes, in the order the card cycles them.
 *
 * Duplicated from `client.js` rather than imported: the two halves are separate
 * bundles and the browser half cannot import a Host module. This list is the single
 * source for the SCHEMA's accepted values; the card's own list must match, and a
 * mismatch would surface as a refused write, which the row reports rather than
 * hiding.
 */
const PLAY_MODES = ['sequence', 'shuffle', 'single']

/**
 * This entry's Host configuration schema.
 *
 * Every field is volatile, because the settings service projects volatile fields
 * and nothing else. The field names are the contract with `client.js`: the row
 * writes `['folder']`, `['enabled']`, `['volume']` and `['mode']` through
 * `configForms`, and this schema is what accepts them.
 *
 * `folder` is a plain string rather than a validated path: any string can be
 * stored (a user may type a path before the drive exists), and an unusable folder
 * is reported by the manifest route as an empty library instead of refusing the
 * write.
 */
export const Config = z.object({
  folder: live(z.string().default(DEFAULT_SETTINGS.folder)),
  enabled: live(z.boolean().default(DEFAULT_SETTINGS.enabled)),
  volume: live(z.number().min(0).max(1).default(DEFAULT_SETTINGS.volume)),
  /**
   * How the next track is chosen.
   *
   * Stored rather than kept in the browser because it is a preference, not
   * playback state: closing the window should not silently reset the user back to
   * sequential. The union is built from {@link PLAY_MODES} so the schema and the
   * card cannot disagree about the accepted values.
   */
  mode: live(z.union([...PLAY_MODES]).default(DEFAULT_SETTINGS.mode)),
})

/** Package name the loader mounts this row as. Also the settings namespace. */
export const name = 'dsh-bgm'

/** Services this half consumes. */
export const inject = ['webServer']

/** Route prefix the browser half fetches from. */
const ROUTE = '/plugins/dsh-bgm'

/**
 * Audio containers this plugin will serve, with their MIME types.
 *
 * A whitelist rather than a suffix passthrough: the byte route answers with a
 * `Content-Type` a browser will hand to its media stack, and serving an arbitrary
 * file from a user-chosen directory as `audio/*` is not something this plugin
 * should be willing to do.
 */
const AUDIO_TYPES = new Map([
  ['.mp3', 'audio/mpeg'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.flac', 'audio/flac'],
  ['.wav', 'audio/wav'],
  ['.ogg', 'audio/ogg'],
  ['.oga', 'audio/ogg'],
  ['.opus', 'audio/ogg'],
  ['.webm', 'audio/webm'],
])

/** MIME type for one file name, or undefined when it is not playable audio. */
function audioType(file) {
  return AUDIO_TYPES.get(extname(file).toLowerCase())
}

/** Send one JSON body and end the response. */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    // The manifest is per-request state (it reflects the live setting), so it
    // must never be reused from a cache.
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * Normalize the configured folder, or `undefined` when nothing usable is set.
 *
 * The value is resolved and then required to be an existing directory. This is
 * also the first half of the containment check the byte route relies on: the
 * track name arrives from a URL, and only a name resolved *against this exact
 * directory* is ever opened.
 *
 * @param value - the raw stored setting.
 * @returns the absolute directory path, or undefined.
 */
async function resolveFolder(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  let absolute
  try {
    absolute = resolve(value.trim())
  } catch {
    return undefined
  }
  try {
    const info = await stat(absolute)
    if (!info.isDirectory()) return undefined
  } catch {
    return undefined
  }
  return absolute
}

/**
 * List the playable files directly inside one directory.
 *
 * Only the top level is read: a folder the user named is the library, and walking
 * it would let one mistyped level pull in thousands of files. Entries whose
 * extension is not in {@link AUDIO_TYPES} are skipped rather than reported, so a
 * folder of mixed files still yields a clean track list.
 *
 * @param folder - an absolute directory path.
 * @returns track descriptors in a stable, case-insensitive name order.
 */
async function listTracks(folder) {
  const entries = await readdir(folder, { withFileTypes: true })
  const tracks = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const type = audioType(entry.name)
    if (type === undefined) continue
    tracks.push({ name: entry.name, type })
  }
  tracks.sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'))
  return tracks
}

/**
 * Build the manifest the browser half plays from.
 *
 * The file list and the plugin's own settings travel together because the row
 * needs both to be useful: a configured folder with no audio files and no folder
 * at all are different states, and only the Host can tell them apart.
 *
 * @param config - the applied config.
 * @returns the manifest body.
 */
async function buildManifest(config) {
  const enabled = readField(config, 'enabled') !== false
  const raw = readField(config, 'folder')
  const folder = await resolveFolder(raw)
  if (folder === undefined) {
    return {
      enabled,
      folder: typeof raw === 'string' ? raw : '',
      resolved: null,
      tracks: [],
      error: typeof raw === 'string' && raw.trim() !== '' ? 'FOLDER_UNUSABLE' : 'FOLDER_UNSET',
    }
  }
  const tracks = await listTracks(folder)
  return {
    enabled,
    folder: folder,
    resolved: folder,
    tracks: tracks.map((track) => ({
      name: track.name,
      type: track.type,
      // The URL carries the resolved folder's identity so a cache entry cannot
      // outlive a change of folder; the byte route re-resolves from `name` alone.
      src: `${ROUTE}/track/${encodeURIComponent(track.name)}`,
    })),
    error: null,
  }
}

/**
 * Answer one byte-route request with a streamed audio file.
 *
 * Range support is not optional here: without `206` a browser cannot seek, and
 * some engines refuse a long track outright. The header is parsed defensively —
 * a malformed or unsatisfiable range answers `416` rather than being coerced into
 * a full-body response, which would make a seeking client wait for the whole file.
 *
 * @param absolute - absolute path of the file to send.
 * @param type - its MIME type.
 * @param req - the incoming request (read for `Range`).
 * @param res - the response to write.
 */
async function serveTrack(absolute, type, req, res) {
  const info = await stat(absolute)
  const total = info.size
  const range = req.headers?.range

  let start = 0
  let end = total - 1
  let status = 200
  const headers = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache',
  }

  if (typeof range === 'string' && range.trim() !== '') {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (match === null) {
      res.writeHead(416, { 'content-range': `bytes */${String(total)}` })
      res.end()
      return
    }
    const [, rawStart, rawEnd] = match
    if (rawStart === '') {
      // A suffix range: the last N bytes.
      const length = Number(rawEnd)
      if (!Number.isFinite(length) || length <= 0) {
        res.writeHead(416, { 'content-range': `bytes */${String(total)}` })
        res.end()
        return
      }
      start = Math.max(0, total - length)
      end = total - 1
    } else {
      start = Number(rawStart)
      end = rawEnd === '' ? total - 1 : Math.min(Number(rawEnd), total - 1)
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
      res.writeHead(416, { 'content-range': `bytes */${String(total)}` })
      res.end()
      return
    }
    status = 206
    headers['content-range'] = `bytes ${String(start)}-${String(end)}/${String(total)}`
  }

  headers['content-length'] = String(end - start + 1)
  res.writeHead(status, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const stream = createReadStream(absolute, { start, end })
  stream.on('error', () => {
    // The headers are already out, so the only honest signal left is to break the
    // connection: a truncated body makes the element retry instead of playing
    // silence.
    if (!res.writableEnded) res.destroy()
  })
  stream.pipe(res)
}

/**
 * Resolve one request URL to a file inside the configured folder.
 *
 * The name is taken as a single path segment and rejected when it is not exactly
 * what it claims to be: no separators, no `.`/`..`, no NUL, and nothing
 * percent-decoded into any of those. The final containment check is a `startsWith`
 * against the folder plus a separator, so even a name that survives the earlier
 * filters cannot escape the configured directory.
 *
 * @param url - the raw request URL.
 * @param folder - the resolved, configured directory.
 * @returns the absolute file path and MIME type, or undefined.
 */
function resolveTrack(url, folder) {
  const path = typeof url === 'string' ? url.split('?')[0] : ''
  const prefix = `${ROUTE}/track/`
  if (!path.startsWith(prefix)) return undefined

  let name
  try {
    name = decodeURIComponent(path.slice(prefix.length))
  } catch {
    return undefined
  }

  if (name === '' || name === '.' || name === '..') return undefined
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return undefined
  if (basename(name) !== name) return undefined

  const type = audioType(name)
  if (type === undefined) return undefined

  const absolute = resolve(join(folder, name))
  if (absolute !== join(folder, name)) return undefined
  if (!absolute.startsWith(folder + sep)) return undefined

  return { absolute, type }
}

/**
 * Mount the Host half.
 *
 * @param ctx - the plugin context.
 * @param config - the validated, live {@link Config}.
 */
export function apply(ctx, config) {
  // This plugin ships its own settings surface (the browser half registers a
  // `settings.general.item` row), so the automatically generated form is
  // declined. The `Config` declaration still has to exist: it is what makes these
  // fields addressable, and what the browser row writes through.
  //
  // `settings` is reached through the optional `ctx.inject` rather than a
  // declared dependency, so a deployment without the settings service still gets
  // the audio routes.
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  if (!LIVE_CAPABLE) {
    ctx.logger?.warn?.(
      'dsh-bgm: the resolved @deepseek-ai/schemastery has no .volatile(), so DSH cannot project this plugin\'s settings; the General-page row will not appear (audio routes still work).',
    )
  }

  const server = ctx.webServer

  // Two routes rather than one prefix on ROUTE. The web server resolves prefixes
  // longest-first, so a prefix on `/plugins/dsh-bgm` would also claim
  // `/plugins/dsh-bgm/client.js` — the URL the browser fetches for this package's
  // own client bundle (client-modules serves every bundle under
  // `/plugins/<package>/client.js`). That request would answer this plugin's 404,
  // the bundle would never materialize, and the settings row would never register.
  // An exact manifest route plus a `/track` prefix leaves every other path to its
  // owner.
  ctx.effect(
    () =>
      server.register({
        kind: 'exact',
        path: `${ROUTE}/manifest.json`,
        handler: (req, res) => {
          void (async () => {
            try {
              sendJson(res, 200, await buildManifest(config))
            } catch (error) {
              ctx.logger?.warn?.('dsh-bgm: manifest read failed', error)
              sendJson(res, 200, {
                enabled: readField(config, 'enabled') !== false,
                folder: String(readField(config, 'folder') ?? ''),
                resolved: null,
                tracks: [],
                error: 'READ_FAILED',
              })
            }
          })()
        },
      }),
    'dsh-bgm: manifest route',
  )

  ctx.effect(
    () =>
      server.register({
        kind: 'prefix',
        path: `${ROUTE}/track`,
        handler: (req, res) => {
          void (async () => {
            const folder = await resolveFolder(readField(config, 'folder'))
            if (folder === undefined) {
              sendJson(res, 404, { error: 'FOLDER_UNUSABLE' })
              return
            }
            const target = resolveTrack(req.url ?? '', folder)
            if (target === undefined) {
              sendJson(res, 404, { error: 'not found' })
              return
            }
            try {
              await serveTrack(target.absolute, target.type, req, res)
            } catch (error) {
              if (error?.code === 'ENOENT' || error?.code === 'EISDIR') {
                sendJson(res, 404, { error: 'not found' })
                return
              }
              throw error
            }
          })().catch((error) => {
            ctx.logger?.error?.('dsh-bgm: track route failed', error)
            if (!res.headersSent) sendJson(res, 500, { error: 'internal' })
            else if (!res.writableEnded) res.destroy()
          })
        },
      }),
    'dsh-bgm: track route',
  )
}

/** Exposed for tests; not part of the plugin contract. */
export const internals = {
  ROUTE,
  AUDIO_TYPES,
  PLAY_MODES,
  audioType,
  resolveFolder,
  listTracks,
  resolveTrack,
  buildManifest,
  readField,
  DEFAULT_SETTINGS,
}
