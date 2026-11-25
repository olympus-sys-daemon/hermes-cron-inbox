/** Assert the title outranks the body visually, from the rendered markup. */
import assert from 'node:assert'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { APP_ROOT, requireLocalHermes } from './harness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(dirname(HERE), 'desktop', 'plugin.js')

const { feed, react, reactDom } = requireLocalHermes({ testsDir: HERE })

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
    return { data: key.includes('"config"') ? d.config : d.feed, isLoading: false, isError: false }
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
const dir = mkdtempSync(join(APP, '.inbox-hier-'))
writeFileSync(join(dir, 'sdk.mjs'), stub)
let out = src.replace(/'@hermes\/plugin-sdk'/g, `'${pathToFileURL(join(dir, 'sdk.mjs')).href}'`)
out += '\nexport { JobCard }\n'
const target = join(dir, 'plugin.mjs')
writeFileSync(target, out)

globalThis.__NEXT_DATA = { feed, config: { poll_seconds: 60 } }

const React = await import(pathToFileURL(react).href)
const { renderToString } = await import(pathToFileURL(reactDom).href)
const mod = await import(pathToFileURL(target).href)

// Size tiers we care about, largest first.
const SIZE_RANK = ['text-base', 'text-sm', 'text-xs', 'text-[0.6875rem]', 'text-[0.625rem]']
const rank = cls => {
  for (let i = 0; i < SIZE_RANK.length; i++) if (cls.includes(SIZE_RANK[i])) return i
  return SIZE_RANK.length
}

// Opacity tiers: primary(94) > secondary(74) > tertiary(54) > quaternary(36).
const TONE_RANK = ['ui-text-primary', 'foreground', 'ui-text-secondary', 'ui-text-tertiary', 'ui-text-quaternary']
const tone = cls => {
  for (let i = 0; i < TONE_RANK.length; i++) if (cls.includes(TONE_RANK[i])) return i
  return TONE_RANK.length
}

let checked = 0

for (const card of feed.cards) {
  if (!card.body) continue
  const html = renderToString(
    React.createElement(mod.JobCard, {
      card,
      t: k => k,
      onOpenHistory: () => {},
      onMarkJobRead: () => {},
      onMute: () => {},
      onRaw: () => {}
    })
  )

  // The title element carries the job name and a size/tone class.
  const titleMatch = html.match(/<span class="([^"]*)"[^>]*>([^<]*)<\/span>/g) ?? []
  const titleEl = titleMatch.find(m => m.includes(card.job_name))
  assert.ok(titleEl, `${card.job_name}: title element not found`)

  const titleCls = titleEl.match(/class="([^"]*)"/)[1]
  // The body is the clickable text block: it carries `cursor-pointer` and the
  // report's opening line. (`cn()` joins classes with spaces, so match on the
  // piece that is unambiguous rather than assuming adjacency.)
  // React writes attributes in source order, so `class` is not the first
  // attribute (the body div carries role/tabIndex first). Match any tag and pull
  // its class out rather than assuming the attribute order.
  const bodyMatches = [...html.matchAll(/<(?:div|span|p)([^>]*)>/g)]
    .map(m => (m[1].match(/class="([^"]*)"/) ?? [])[1] ?? '')
    .filter(c => c.includes('cursor-pointer') && c.includes('whitespace-pre-wrap'))
  assert.ok(bodyMatches.length > 0, `${card.job_name}: body element not found`)
  const bodyCls = bodyMatches[0]

  const titleSize = rank(titleCls)
  const bodySize = rank(bodyCls)
  const titleTone = tone(titleCls)
  const bodyTone = tone(bodyCls)

  // BIGGER means a LOWER rank index.
  assert.ok(
    titleSize <= bodySize,
    `${card.job_name}: title is not larger than body ` +
    `(title=${SIZE_RANK[titleSize] ?? 'none'}, body=${SIZE_RANK[bodySize] ?? 'none'})`
  )
  assert.ok(
    titleTone <= bodyTone,
    `${card.job_name}: title is dimmer than body ` +
    `(title=${TONE_RANK[titleTone] ?? 'none'}, body=${TONE_RANK[bodyTone] ?? 'none'})`
  )
  // A rule under the title separates the two without relying on colour.
  assert.match(titleCls + html, /border-b/, `${card.job_name}: no rule separating title from body`)

  checked++
}

assert.ok(checked > 0, 'no cards with bodies to check')
console.log(`ok   title outranks body on ${checked} cards (larger type, stronger tone, hairline rule)`)
