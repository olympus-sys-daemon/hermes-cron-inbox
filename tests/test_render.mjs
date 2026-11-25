/**
 * Render the dashboard against real feed data, deep enough to prove the cards
 * carry their text.
 *
 * The shallow harness only proves the page issues the right request. It cannot
 * see inside a card, because a fake `jsx` never invokes children — so a card
 * with a broken prop, a hook-order mistake, or a body that silently fails to
 * render would pass. This walks the tree, calls every function component, and
 * asserts the report text is present in the output.
 *
 * Self-contained: the SDK/react stubs are generated here, so it runs anywhere
 * with node and a cron corpus (no local harness directory, no absolute paths).
 */
import assert from 'node:assert'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = dirname(HERE)
const SRC = join(REPO, 'desktop', 'plugin.js')

// --- real feed data from the real backend ----------------------------------
const venvPython = process.env.PYTHON_BIN ?? 'python3'

const raw = execFileSync(venvPython, ['-I', join(HERE, 'probe_feed.py')], {
  stdio: ['ignore', 'pipe', 'inherit'],
  env: { ...process.env }
})
const feed = JSON.parse(raw.toString())
assert.ok(feed.cards?.length > 0, 'feed returned no cards to render')

// --- stubs, generated from the plugin's own imports -------------------------
const src = readFileSync(SRC, 'utf8')
const sdkImport = src.match(/import \{([\s\S]*?)\} from '@hermes\/plugin-sdk'/)
const sdkNames = sdkImport[1].split(',').map(s => s.trim()).filter(Boolean)

const CONTAINERS = new Set(['ScrollArea', 'Skeleton'])
const stubOverrides = {
  ScrollArea: `export const ScrollArea = p => p?.children ?? null`,
  useQuery: `export const useQuery = o => {
    globalThis.__LAST_QUERY = o
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

const sdkStub = sdkNames
  .map(n => stubOverrides[n] ?? `export const ${n} = () => null`)
  .join('\n')

const dir = mkdtempSync(join(tmpdir(), 'inbox-render-'))
writeFileSync(join(dir, 'sdk.mjs'), sdkStub)
writeFileSync(join(dir, 'jsx.mjs'), `
export const jsx = (type, props) => ({ type, props: props ?? {} })
export const jsxs = (type, props) => ({ type, props: props ?? {} })
export const Fragment = Symbol.for('react.fragment')
`)
writeFileSync(join(dir, 'react.mjs'), `
export const useCallback = f => f
export const useMemo = f => f()
export const useState = v => [typeof v === 'function' ? v() : v, () => {}]
export const useEffect = () => {}
export const useRef = v => ({ current: v })
`)

let out = src
for (const [spec, file] of [
  ['@hermes/plugin-sdk', 'sdk.mjs'],
  ['react/jsx-runtime', 'jsx.mjs'],
  ['react', 'react.mjs']
]) {
  out = out.split(`'${spec}'`).join(`'${pathToFileURL(join(dir, file)).href}'`)
}
out += '\nexport { InboxPage, JobCard }\n'
const target = join(dir, 'plugin.mjs')
writeFileSync(target, out)

globalThis.__NEXT_DATA = {
  feed,
  config: { include_silent_by_default: false, poll_seconds: 60 }
}

const mod = await import(pathToFileURL(target).href)

// --- deep render ------------------------------------------------------------
function textOf(node, acc = []) {
  if (node == null || node === false || node === true) return acc
  if (typeof node === 'string' || typeof node === 'number') {
    acc.push(String(node))
    return acc
  }
  if (Array.isArray(node)) {
    for (const n of node) textOf(n, acc)
    return acc
  }
  if (typeof node === 'object') {
    if (typeof node.type === 'function') {
      textOf(node.type({ ...(node.props ?? {}) }), acc)
      return acc
    }
    textOf(node.props?.children, acc)
  }
  return acc
}

const t = (k, ...args) => (typeof k === 'string' ? k : String(k))

assert.equal(typeof mod.InboxPage, 'function', 'InboxPage is not exported')
assert.equal(typeof mod.JobCard, 'function', 'JobCard is not exported')

const pageText = textOf(mod.InboxPage({ ctx: { rest: async () => feed } })).join(' ')
assert.ok(pageText.length > 200, `InboxPage rendered almost nothing (${pageText.length} chars)`)

// Every card must carry its own body text: that is the entire redesign.
let bodies = 0
for (const card of feed.cards) {
  const txt = textOf(
    mod.JobCard({
      card,
      t,
      onOpenHistory: () => {},
      onMarkJobRead: () => {},
      onMute: () => {}
    })
  ).join(' ')

  assert.ok(txt.includes(card.job_name), `card lost its title: ${card.job_name}`)
  assert.ok(!txt.includes('undefined'), `card ${card.job_name} rendered "undefined"`)
  assert.ok(!txt.includes('[object'), `card ${card.job_name} rendered an object`)

  if (card.body) {
    const firstLine = card.body.split('\n').map(s => s.trim()).find(Boolean) ?? ''
    if (firstLine) {
      assert.ok(
        txt.includes(firstLine.slice(0, 40)),
        `card body did not reach the DOM for ${card.job_name}: ` +
        `expected "${firstLine.slice(0, 40)}"`
      )
      bodies++
    }
  }
}

assert.ok(bodies > 0, 'no card rendered a body')

// A card that claims "New" must also report unread runs, or the badge lies.
for (const card of feed.cards) {
  if (card.unread) {
    assert.ok(card.unread_runs > 0, `${card.job_name}: says unread but unread_runs is 0`)
  }
}

console.log(
  `ok   dashboard renders: ${feed.cards.length} cards, ${bodies} with body text, ` +
  `${pageText.length} chars of page text`
)
