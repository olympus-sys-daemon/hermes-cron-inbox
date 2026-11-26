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
  // Presentational primitives render a REAL element carrying their props.
  // Defaulting them to `() => null` made every button's label, aria-pressed and
  // icon invisible to this test - which is how a control can ship with the same
  // appearance in both states and nothing notices.
  Button: `export const Button = p => React.createElement('button', {
    'aria-pressed': p['aria-pressed'],
    'aria-label': p['aria-label'],
    title: p.title,
    className: p.className
  }, p.children)`,
  Badge: `export const Badge = p => React.createElement('span', { className: p.className }, p.children)`,
  Codicon: `export const Codicon = p => React.createElement('i', {
    className: 'codicon codicon-' + p.name
  })`,
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
    storage: {
      get: (k, d) => (k === 'notifications_enabled'
        ? globalThis.__NOTIFY_PREF ?? d
        : d),
      set: () => {}
    },
    notify: () => {},
    navigate: () => {},
    onEvent: () => () => {}
  }`
}

const sdkStub =
  `import * as React from 'react'\n` +
  sdkNames.map(n => overrides[n] ?? `export const ${n} = () => null`).join('\n')

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

globalThis.__NOTIFY_PREF = true
let html
let htmlOff
try {
  html = renderToString(React.createElement(mod.InboxPage, { ctx: { rest: async () => feed } }))
  // Render the OFF state too. Asserting only the default state cannot see a
  // control whose icon or label never changes - the exact silent-state bug
  // this switch exists to avoid.
  globalThis.__NOTIFY_PREF = false
  htmlOff = renderToString(React.createElement(mod.InboxPage, { ctx: { rest: async () => feed } }))
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

// --- the notification switch ------------------------------------------------
// A control that looks identical in both states is the classic silent-state
// bug: the user cannot tell whether notifications are on. Assert the three
// things that make the state visible, not merely that a button exists.
const textOff = htmlOff.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

function switchState(markup, visible, wantOn) {
  // Scope to the TOGGLE itself. Bells are also the mute controls' icons, so a
  // page-wide search finds a bell in any state and proves nothing.
  const buttons = markup.split('<button').slice(1)
  const toggle = buttons.find(b => /aria-pressed=/.test(b))
  if (!toggle) return 'no button carries aria-pressed'
  if (!new RegExp(`aria-pressed="${wantOn}"`).test(toggle)) {
    return `aria-pressed is not ${wantOn}`
  }
  const label = wantOn ? 'Notifications on' : 'Notifications off'
  if (!toggle.includes(label)) return `the toggle does not say "${label}"`
  if (!visible.includes(label)) return `"${label}" is not visible text`
  // Match the class TOKEN, not a substring: `codicon-bell-slash` contains
  // `codicon-bell`, so a plain includes() would miss the very pair being
  // distinguished.
  const has = name => new RegExp(`codicon-${name}(?![\\w-])`).test(toggle)
  const icon = wantOn ? 'bell' : 'bell-slash'
  const other = wantOn ? 'bell-slash' : 'bell'
  if (!has(icon)) return `the toggle does not use codicon-${icon}`
  if (has(other)) return `the toggle also renders codicon-${other}, so its icon lies`
  // Off must also LOOK off, not merely announce it: the dimmed state is the
  // at-a-glance signal, and aria alone is invisible to a sighted user.
  if (!wantOn && !/opacity-60/.test(toggle)) {
    return 'the OFF toggle is not visually distinguished (missing opacity-60)'
  }
  return null
}

for (const [markup, visible, wantOn, name] of [
  [html, text, true, 'ON'],
  [htmlOff, textOff, false, 'OFF']
]) {
  const problem = switchState(markup, visible, wantOn)
  if (problem) {
    console.error(`notification switch in the ${name} state: ${problem}`)
    process.exit(1)
  }
}

console.log(`ok   real React rendered ${feed.cards.length} cards, ${bodies} with body text`)
console.log(`     notification switch verified in BOTH states (on: bell, off: bell-slash)`)
console.log(`     html ${html.length} chars, visible text ${text.length} chars`)
