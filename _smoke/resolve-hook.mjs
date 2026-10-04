/**
 * The resolver hook behind `register-resolver.mjs`.
 *
 * It answers exactly one specifier — `@deepseek-ai/schemastery` — with whatever
 * `resolve-schemastery.mjs` locates, and defers every other specifier to Node's
 * default resolution. Answering anything else would make a suite behave differently
 * from production in a way nobody would notice.
 */

import { findSchemasteryPath } from './resolve-schemastery.mjs'
import { pathToFileURL } from 'node:url'

const TARGET = '@deepseek-ai/schemastery'

/** The located entry, memoized after the first call. */
let entry

/** The resolved `file://` URL, or undefined when no copy is installed. */
function targetUrl() {
  if (entry === undefined) entry = findSchemasteryPath() ?? null
  return entry === null ? undefined : pathToFileURL(entry).href
}

/**
 * Module resolution hook.
 *
 * @param specifier - the requested specifier.
 * @param context - resolution context from Node.
 * @param nextResolve - the default resolver to defer to.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier !== TARGET) return nextResolve(specifier, context)
  const url = targetUrl()
  if (url === undefined) return nextResolve(specifier, context)
  return { url, shortCircuit: true }
}
