/**
 * Locate `@deepseek-ai/schemastery` for the offline suites.
 *
 * The suites import the plugin's real `index.js`, which statically imports
 * `@deepseek-ai/schemastery`. That package is a PEER dependency: the DSH host
 * supplies it, and the plugin must never vendor its own copy (a second copy of the
 * schema library is exactly what makes a Config schema fail to project). So a fresh
 * clone has no `node_modules` and a bare `import '../index.js'` fails with
 * `ERR_MODULE_NOT_FOUND`.
 *
 * Rather than make the tests depend on a local install, they ask this module for the
 * library. It looks in the places a DSH deployment actually keeps it, in order:
 *
 *   1. `DSH_SCHEMASTER_PATH` — an explicit override, for an unusual layout.
 *   2. The plugin's own `node_modules` — the normal case for a linked/dev checkout.
 *   3. The DSH profile's `node_modules` — `~/.dsh/profiles/<name>`.
 *   4. The DSH application payload — `resources/app.asar.unpacked` and the
 *      `app.asar` archive itself, where the kernel's copy lives.
 *
 * A hit is verified by loading it and checking for `object`, so an unrelated
 * directory named `schemastery` is rejected instead of producing a confusing
 * failure later.
 *
 * Import it as: `const z = await loadSchemastery()`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

/** Directories a DSH deployment is likely to hold the library in. */
function candidateRoots() {
  const roots = []
  if (process.env.DSH_SCHEMASTER_PATH) roots.push(process.env.DSH_SCHEMASTER_PATH)

  // The plugin's own node_modules (present in a linked dev checkout).
  roots.push(join(import.meta.dirname, '..', 'node_modules', '@deepseek-ai', 'schemastery'))

  // Every DSH profile, plus the shared home-level node_modules.
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  roots.push(join(dshHome, 'node_modules', '@deepseek-ai', 'schemastery'))
  const profiles = join(dshHome, 'profiles')
  for (const name of ['desktop', 'web', 'default']) {
    roots.push(join(profiles, name, 'node_modules', '@deepseek-ai', 'schemastery'))
  }

  // The DSH application payload. `app.asar.unpacked` may hold only native modules,
  // so the archive itself is tried separately below.
  for (const base of [
    'A:\\dsh\\resources',
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources'),
    '/Applications/DeepSeek Harness.app/Contents/Resources',
    join('/opt', 'DeepSeek Harness', 'resources'),
  ]) {
    if (base && existsSync(base)) {
      roots.push(join(base, 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'schemastery'))
    }
  }
  return roots
}

/**
 * Read a file out of an asar archive.
 *
 * An asar is a JSON header followed by concatenated file bodies. Only the flat
 * `node_modules/<pkg>/lib/index.cjs` shape is needed here, so this walks the header
 * to the one entry and slices the body out.
 *
 * @param archive - path to the `.asar`.
 * @param innerPath - slash-separated path inside the archive.
 * @returns the file bytes, or undefined when absent.
 */
function readFromAsar(archive, innerPath) {
  let buffer
  try {
    buffer = readFileSync(archive)
  } catch (error) {
    return undefined
  }
  // Header: 4-byte size of a pickle, then a pickle holding the JSON length and JSON.
  const headerSize = buffer.readUInt32LE(4)
  const jsonLength = buffer.readUInt32LE(12)
  let header
  try {
    header = JSON.parse(buffer.subarray(16, 16 + jsonLength).toString('utf8'))
  } catch (error) {
    return undefined
  }
  const dataStart = 8 + headerSize
  let node = header
  for (const segment of innerPath.split('/')) {
    if (node === null || node === undefined || node.files === undefined) return undefined
    node = node.files[segment]
  }
  if (node === null || node === undefined || typeof node.size !== 'number') return undefined
  return buffer.subarray(dataStart + Number(node.offset), dataStart + Number(node.offset) + node.size)
}

/**
 * Find the `lib/index.cjs` entry of the Host's schema library.
 *
 * Split out from {@link loadSchemastery} so the resolver hook can reuse the very
 * same search and answer with a PATH, which is what a module hook needs.
 *
 * @returns an absolute path, or undefined when no copy is installed.
 */
export function findSchemasteryPath() {
  try {
    const resolved = require.resolve('@deepseek-ai/schemastery')
    if (existsSync(resolved)) return resolved
  } catch (error) {
    /* fall through to the explicit search */
  }
  for (const directory of candidateRoots()) {
    const entry = join(directory, 'lib', 'index.cjs')
    if (existsSync(entry)) return entry
  }
  return undefined
}

/**
 * Load the Host's schema library.
 *
 * @returns the schemastery module namespace's default export (with `object`, etc.).
 * @throws when no copy is found, naming every location that was tried.
 */
export async function loadSchemastery() {
  // `require` first: it resolves through the ordinary node algorithm, which covers
  // a plain `npm i @deepseek-ai/schemastery` in this package.
  const installed = findSchemasteryPath()
  if (installed !== undefined) {
    const module = await import(pathToFileURL(installed).href)
    const z = module.default ?? module
    if (typeof z?.object === 'function') return z
  }

  const tried = candidateRoots()

  // Last resort: the packaged archive.
  for (const archive of [
    'A:\\dsh\\resources\\app.asar',
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'),
  ]) {
    if (!archive || !existsSync(archive)) continue
    for (const inner of [
      'dsh/node_modules/@deepseek-ai/schemastery/lib/index.cjs',
      'node_modules/@deepseek-ai/schemastery/lib/index.cjs',
    ]) {
      tried.push(archive + '!' + inner)
      const bytes = readFromAsar(archive, inner)
      if (bytes === undefined) continue
      const module = await import(
        'data:text/javascript;base64,' + Buffer.from(bytes).toString('base64')
      )
      const z = module.default ?? module
      if (typeof z?.object === 'function') return z
    }
  }

  throw new Error(
    'Could not locate @deepseek-ai/schemastery (a DSH peer dependency).\n' +
      'Point DSH_SCHEMASTER_PATH at a directory containing lib/index.cjs, or install it:\n' +
      '  npm i -D @deepseek-ai/schemastery\n' +
      'Tried:\n  ' +
      tried.join('\n  '),
  )
}
