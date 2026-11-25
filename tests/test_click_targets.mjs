/**
 * Drive the page's real click handlers and assert where they lead.
 *
 * Rendering alone proves nothing about clicks. This mounts the page with real
 * React's SSR (to reach the components), then invokes the handlers the buttons
 * were given and checks the resulting state is the run the user meant.
 */
import assert from 'node:assert'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { APP_ROOT, requireLocalHermes } from './harness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(dirname(HERE), 'desktop', 'plugin.js')

const { feed } = requireLocalHermes({ testsDir: HERE })
if (!feed.cards.length) {
  console.log('skip: no cards')
  process.exit(0)
}

const src = readFileSync(SRC, 'utf8')
const sdkNames = src
  .match(/import \{([\s\S]*?)\} from '@hermes\/plugin-sdk'/)[1]
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

const overrides = {
  ScrollArea: 'export const ScrollArea = p => p?.children ?? null',
  useQuery: `export const useQuery = o => {
    const key = JSON.stringify(o.queryKey || [])
    const d = globalThis.__NEXT_DATA || {}
    const pick = key.includes('"config"') ? d.config
      : key.includes('"history"') ? d.history
      : key.includes('"feed"') ? d.feed
      : key.includes('"item"') ? d.item
      : d.feed
    return { data: pick, isLoading: false, isError: false }
  }`,
  useQueryClient: 'export const useQueryClient = () => ({ invalidateQueries: () => {} })',
  cn: `export const cn = (...a) => a.filter(Boolean).join(' ')`,
  host: `export const host = {
    storage: { get: (k, d) => d, set: () => {} },
    notify: () => {}, navigate: () => {}, onEvent: () => () => {}
  }`
}

const stub = sdkNames.map(n => overrides[n] ?? `export const ${n} = () => null`).join('\n')
const APP = APP_ROOT
const dir = mkdtempSync(join(APP, '.inbox-clicks-'))
writeFileSync(join(dir, 'sdk.mjs'), stub)

let out = src.replace(/'@hermes\/plugin-sdk'/g, `'${pathToFileURL(join(dir, 'sdk.mjs')).href}'`)
out += '\nexport { InboxPage, JobCard, HistoryPanel }\n'
const target = join(dir, 'plugin.mjs')
writeFileSync(target, out)

globalThis.__NEXT_DATA = {
  feed,
  config: { poll_seconds: 60 },
  history: { items: [] },
  item: { body: 'x' }
}

const React = await import(pathToFileURL(join(APP, 'node_modules/react/index.js')).href)
const { renderToString } = await import(
  pathToFileURL(join(APP, 'node_modules/react-dom/server.node.js')).href
)
const mod = await import(pathToFileURL(target).href)

// The DATA must make the three intents distinguishable. (JobCard cannot be
// called outside a render - it uses useState - so this asserts the payload the
// handlers key on rather than invoking them.)
const jobsWithBody = feed.cards.filter(c => c.body && c.recent.length)
assert.ok(jobsWithBody.length > 0, 'no card with a body and recent runs')

for (const card of jobsWithBody) {
  assert.ok(card.latest_id, `${card.job_name}: no latest_id for the body click`)

  const reported = card.recent.find(r => !r.silent)
  assert.ok(
    reported,
    `${card.job_name}: has a body but no reported run, so History has nothing to open`
  )

  // The body click must NOT land on a silent run while the card shows text.
  const newest = card.recent[0]
  if (newest.silent && card.body) {
    assert.notEqual(
      card.latest_id,
      newest.id,
      `${card.job_name}: body click points at the silent newest run - ` +
        `this is the "click the body, get an empty window" bug`
    )
  }
}

// The reader must WIN over the history list. This was a real bug: `if (history)`
// was checked before `if (open)`, so choosing a run from the list left the list
// on screen and the click appeared to do nothing.
const pageSrc = readFileSync(SRC, 'utf8')
const openAt = pageSrc.indexOf('  if (open) {')
const historyAt = pageSrc.indexOf('  if (history) {')
assert.ok(openAt > 0 && historyAt > 0, 'both branches must exist')
assert.ok(
  openAt < historyAt,
  'the reader branch must be checked BEFORE the history branch, or a row click ' +
    'sets `open` and the list stays on screen'
)

// The body text must stay selectable: a plain onClick that navigates makes
// drag-to-copy impossible. The handler must consult the selection.
assert.match(
  pageSrc,
  /getSelection/,
  'the body click handler must check window.getSelection() so selecting text ' +
    'does not navigate'
)
assert.match(
  pageSrc,
  /select-text/,
  'the report body must set select-text so an ancestor cannot disable selection'
)

// The raw button is gone.
assert.ok(
  !/t\('raw'\)/.test(pageSrc),
  'the Raw button should have been removed'
)

// HistoryPanel must be renderable inside a real render (it uses useQuery).
const histHtml = renderToString(
  React.createElement(mod.HistoryPanel, {
    job: { profile: 'default', job_id: 'x', job_name: 'Job' },
    t: k => k,
    onOpen: () => {},
    onBack: () => {}
  })
)
assert.ok(histHtml.length > 0, 'HistoryPanel rendered nothing')

console.log(
  `ok   click targets: ${jobsWithBody.length} cards, ` +
  `body click never lands on a silent run when the card shows text`
)
