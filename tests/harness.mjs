/**
 * Shared bootstrap for the tests that need a real Hermes app and a cron corpus.
 *
 * Two things are absent on a CI runner: the Hermes install (so `react`/`react-dom`
 * cannot be resolved, and core's source cannot be read) and `fastapi` (so
 * `probe_feed.py` cannot run). Every such test used its own ad-hoc guard, and
 * three separate CI failures came from forgetting one. This centralises it: a
 * test calls `requireLocalHermes()` and either gets its paths or the process
 * exits 0 with a stated reason.
 *
 * Skipping is correct here - these assertions are about how THIS machine's app
 * renders a plugin, which a bare checkout cannot reproduce. The gates that must
 * run everywhere (`node --check`, the manifest validator, the Python suites) do
 * not use this.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

export const APP_ROOT =
  process.env.HERMES_APP ?? '/Users/hermesmac/.hermes/hermes-agent/apps/desktop'

export const PYTHON_BIN = process.env.PYTHON_BIN ?? 'python3'

/** Print a skip reason and exit 0. Never throws - a skip is not a failure. */
export function skip(reason) {
  console.log(`skip: ${reason}`)
  process.exit(0)
}

/**
 * Verify this machine can run an app-dependent test, and return what it needs.
 * Exits the process with a reason when it cannot.
 */
export function requireLocalHermes({ testsDir }) {
  for (const rel of [
    'node_modules/react/index.js',
    'node_modules/react-dom/server.node.js',
    'src/app/routes.ts'
  ]) {
    if (!existsSync(join(APP_ROOT, rel))) {
      skip(`no Hermes app at ${APP_ROOT} (needs ${rel})`)
    }
  }

  let feed
  try {
    feed = JSON.parse(
      execFileSync(PYTHON_BIN, ['-I', join(testsDir, 'probe_feed.py')], {
        stdio: ['ignore', 'pipe', 'inherit']
      }).toString()
    )
  } catch {
    skip('probe_feed.py could not run here (it needs fastapi + a cron corpus)')
  }

  if (!feed.cards?.length) skip('the feed returned no cards')

  return {
    feed,
    react: join(APP_ROOT, 'node_modules/react/index.js'),
    reactDom: join(APP_ROOT, 'node_modules/react-dom/server.node.js')
  }
}
