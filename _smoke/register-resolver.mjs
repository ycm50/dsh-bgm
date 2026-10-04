/**
 * A Node module-resolution hook that serves `@deepseek-ai/schemastery` from the
 * local DSH installation.
 *
 * Why a hook rather than a shim import: the plugin's `index.js` imports the library
 * with a bare specifier at module-evaluation time. The test cannot rewrite that
 * import, and the library must not be vendored into this repo (a second copy of the
 * schema package is what makes a Config schema fail to project). A resolver hook is
 * the one seam that fixes the specifier without touching either side.
 *
 * Use it by running a suite with:
 *
 *   node --import ./_smoke/register-resolver.mjs _smoke/logic-smoke.mjs
 *
 * `resolve-schemastery.mjs` does the actual locating; this file only registers it.
 */

import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

register('./resolve-hook.mjs', pathToFileURL(import.meta.filename))
