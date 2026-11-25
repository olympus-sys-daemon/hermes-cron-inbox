/**
 * Render the Inbox page with REAL React and react-dom/server.
 *
 * The stub-based tests cannot catch a genuine runtime error: a stubbed hook
 * returns whatever the stub returns, and a fake jsx never invokes children. Only
 * real React enforces the rules that actually break a page — calling a hook
 * inside a nested function of a component is the classic one, and it throws in
 * real React while sailing through every stub.
 *
 * Run from apps/desktop so `react`/`react-dom` resolve to the app's own copies.
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { APP_ROOT, requireLocalHermes } from './harness.mjs'

const HERE_DIR = dirname(fileURLToPath(import.meta.url))
const REPO = dirname(HERE_DIR)
const SRC = join(REPO, 'desktop', 'plugin.js')
const HERE = join(REPO, 'tests')

// --- real feed payload, via the shared bootstrap ---------------------------
const { feed } = requireLocalHermes({ testsDir: HERE })

// --- stubs for the plugin SDK, real react otherwise -------------------------
const src = readFileSync(SRC, 'utf8')
const sdkImport = src.match(/import \{([\s\S]*?)\} from '@hermes\/plugin-sdk'/)
const sdkNames = sdkImport[1].split(',').map(s => s.trim()).filter(Boolean)

const overrides = {
  ScrollArea: `export const ScrollArea = p => p?.children ?? null`,
  useQuery: `export const useQuery = o => {
    const key = JSON.stringify(o.queryKey || [])
    const d = globalThis.__NEXT_DATA || {}
    const pick = key.includes('"config"') ? d.config
      : key.includes('"feed"') ? d.feed
      : key.includes('"summary"') ? d.feed
      : key.includes('"item"') ? d.item
      : d.feed
    return { data: pick, isLoading: pick === undefined, isError: false }
  }`,
  useQueryClient: `export const useQueryClient = () => ({ invalidateQueries: () => {} })`,
  cn: `export const cn = (...a) => a.filter(Boolean).join(' ')`,
  host: `export const host = {
    storage: { get: (k, d) => d, set: () => {} },
    notify: () => {},
    navigate: () => {},
    onEvent: () => () => {}
  }`
}

const sdkStub = sdkNames.map(n => overrides[n] ?? `export const ${n} = () => null`).join('\n')

// The generated module must sit INSIDE the app tree so its bare `react` imports
// resolve to the app's own copy. /tmp has no node_modules.
const dir = mkdtempSync(join(APP_ROOT, '.inbox-real-'))
writeFileSync(join(dir, 'sdk.mjs'), sdkStub)

let out = src.replace(/'@hermes\/plugin-sdk'/g, `'${pathToFileURL(join(dir, 'sdk.mjs')).href}'`)
// `react` and `react/jsx-runtime` are left ALONE: they must resolve to the real
// react installed in apps/desktop.
out += '\nexport { InboxPage }\n'
const target = join(dir, 'plugin.mjs')
writeFileSync(target, out)

globalThis.__NEXT_DATA = {
  feed,
  config: { include_silent_by_default: false, poll_seconds: 60 }
}

// ESM resolves bare specifiers from THIS file's location, not the cwd, so the
// app's react must be imported by absolute path.
const APP_MODULES = process.env.APP_NODE_MODULES ?? '/Users/hermesmac/.hermes/hermes-agent/apps/desktop/node_modules'
const React = await import(pathToFileURL(join(APP_MODULES, 'react', 'index.js')).href)
const { renderToString } = await import(
  pathToFileURL(join(APP_MODULES, 'react-dom', 'server.node.js')).href
)

const mod = await import(pathToFileURL(target).href)

let html
try {
  html = renderToString(React.createElement(mod.InboxPage, { ctx: { rest: async () => feed } }))
} catch (err) {
  console.error('REAL REACT RENDER FAILED:')
  console.error(err?.stack ?? err)
  process.exit(1)
}

// Strip tags to compare visible text against the data.
const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

const jobNames = feed.cards.map(c => c.job_name)
const missing = jobNames.filter(n => !text.includes(n))
if (missing.length) {
  console.error(`cards missing from real render: ${missing.join(', ')}`)
  console.error(`rendered text (first 400): ${text.slice(0, 400)}`)
  process.exit(1)
}

let bodies = 0
for (const card of feed.cards) {
  const firstLine = (card.body || '').split('\n').map(s => s.trim()).find(Boolean) ?? ''
  if (firstLine && text.includes(firstLine.slice(0, 40))) bodies++
}

if (bodies === 0) {
  console.error('no card body text survived a real render')
  process.exit(1)
}

console.log(`ok   real React rendered ${feed.cards.length} cards, ${bodies} with body text`)
console.log(`     html ${html.length} chars, visible text ${text.length} chars`)
