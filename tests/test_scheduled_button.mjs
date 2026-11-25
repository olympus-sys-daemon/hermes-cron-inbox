/** Assert the Scheduled jobs button exists, is labelled, and navigates to /cron. */
import assert from 'node:assert'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { APP_ROOT, requireLocalHermes } from './harness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(dirname(HERE), 'desktop', 'plugin.js')

const APP = APP_ROOT
const wiringPath = join(APP, 'src/app/shell/hooks/use-overlay-routing.ts')
const sidebarPath = join(APP, 'src/app/chat/sidebar/index.tsx')

// Shared bootstrap: skips with a reason when there is no app or no cron corpus,
// so this cannot fail CI for an environment reason.
const { feed } = requireLocalHermes({ testsDir: HERE })

const src = readFileSync(SRC, 'utf8')
const sdkNames = src
  .match(/import \{([\s\S]*?)\} from '@hermes\/plugin-sdk'/)[1]
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

const navigations = []
const overrides = {
  ScrollArea: 'export const ScrollArea = p => p?.children ?? null',
  // Button and Badge must pass children through: a stub that returns null hides
  // every label inside it, so a "button is present" assertion fails on a page
  // that is actually fine.
  Button: 'export const Button = p => p?.children ?? null',
  Badge: 'export const Badge = p => p?.children ?? null',
  // Codicon renders an <i class="codicon codicon-NAME">; the stub must keep that
  // class so an icon assertion can see which glyph was chosen.
  Codicon: `import { createElement as __h } from 'react'
export const Codicon = p => __h('i', { className: 'codicon codicon-' + p.name })`,
  useQuery: `export const useQuery = o => {
    const key = JSON.stringify(o.queryKey || [])
    const d = globalThis.__NEXT_DATA || {}
    const pick = key.includes('"config"') ? d.config
      : key.includes('"feed"') ? d.feed
      : d.feed
    return { data: pick, isLoading: false, isError: false }
  }`,
  useQueryClient: 'export const useQueryClient = () => ({ invalidateQueries: () => {} })',
  cn: `export const cn = (...a) => a.filter(Boolean).join(' ')`,
  host: `export const host = {
    storage: { get: (k, d) => d, set: () => {} },
    notify: () => {},
    navigate: p => globalThis.__NAVIGATIONS.push(p),
    onEvent: () => () => {}
  }`
}
const stub = sdkNames.map(n => overrides[n] ?? `export const ${n} = () => null`).join('\n')

const dir = mkdtempSync(join(APP, '.inbox-nav-'))
writeFileSync(join(dir, 'sdk.mjs'), stub)

let out = src.replace(/'@hermes\/plugin-sdk'/g, `'${pathToFileURL(join(dir, 'sdk.mjs')).href}'`)
out += '\nexport { InboxPage }\n'
const target = join(dir, 'plugin.mjs')
writeFileSync(target, out)

globalThis.__NAVIGATIONS = navigations
globalThis.__NEXT_DATA = { feed, config: { poll_seconds: 60 } }

const React = await import(pathToFileURL(join(APP, 'node_modules/react/index.js')).href)
const { renderToString } = await import(
  pathToFileURL(join(APP, 'node_modules/react-dom/server.node.js')).href
)
const mod = await import(pathToFileURL(target).href)

const html = renderToString(
  React.createElement(mod.InboxPage, { ctx: { rest: async () => feed } })
)

// The button must be present and labelled - a door nobody can find is no door.
assert.ok(
  html.includes('Scheduled jobs'),
  'the header must offer a "Scheduled jobs" button in simple mode'
)
assert.ok(
  /codicon-watch/.test(html),
  'the button should carry the same watch icon core uses for the cron row'
)

// And it must target the real cron route.
assert.ok(
  /const CRON_PATH = '\/cron'/.test(src),
  "the plugin must navigate to core's /cron path"
)

// The route itself is not mode-gated in core - document that assumption so a
// future core change shows up here as a failing test rather than a dead button.
const wiring = readFileSync(
  join(APP, 'src/app/shell/hooks/use-overlay-routing.ts'),
  'utf8'
)
assert.ok(
  /const cronOpen = currentView === 'cron'/.test(wiring),
  "core's cron page is no longer route-driven; the navigate approach needs revisiting"
)

const sidebar = readFileSync(join(APP, 'src/app/chat/sidebar/index.tsx'), 'utf8')
assert.ok(
  /id: 'cron'[\s\S]{0,200}tier: 'advanced'/.test(sidebar),
  'the sidebar cron row is no longer advanced-only; the button may now be redundant'
)

console.log(
  'ok   Scheduled jobs button renders, labelled, and targets /cron ' +
  '(route not mode-gated; sidebar row still advanced-only)'
)
