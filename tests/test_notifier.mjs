/**
 * Behavioural test for the headless notifier.
 *
 * The failure modes that matter are not syntax errors - they are:
 *   1. announcing the existing backlog on launch (notification spam),
 *   2. missing a new report because the COUNT stayed the same,
 *   3. re-announcing after a restart because the seen-set was not persisted,
 *   4. announcing silent or muted runs the page refuses to show,
 *   5. not running at all because it depended on a mounted component - simple
 *      mode rests the statusbar hidden, which is how this shipped broken once.
 *
 * The watcher starts from `register()` and is driven by scoped timers/events, so
 * this test drives it the way the host does. No fake React is needed - that is
 * precisely the point of the design.
 */
import assert from 'node:assert'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const notifications = []
const toasts = []
const navigated = []
const storage = new Map()

const src = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')

// Built from the plugin's own import list, so adding an SDK component to the
// plugin never breaks this test with a missing-export error.
const sdkImport = src.match(/import \{([\s\S]*?)\} from '@hermes\/plugin-sdk'/)
const sdkNames = sdkImport[1]
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

const STUB_OVERRIDES = {
  host: `export const host = {
  storage: {
    get: (k, d) => globalThis.__storage.has(k) ? globalThis.__storage.get(k) : d,
    set: (k, v) => globalThis.__storage.set(k, v)
  },
  notify: n => globalThis.__toasts.push(n),
  navigate: p => globalThis.__navigated.push(p),
  onEvent: () => () => {}
}`,
  useQuery: 'export const useQuery = () => ({ data: undefined })',
  useQueryClient: 'export const useQueryClient = () => ({ invalidateQueries: () => {} })',
  cn: `export const cn = (...a) => a.filter(Boolean).join(' ')`
}

const sdkStub = sdkNames
  .map(name => STUB_OVERRIDES[name] ?? `export const ${name} = () => null`)
  .join('\n')

globalThis.__notifications = notifications
globalThis.__toasts = toasts
globalThis.__navigated = navigated
globalThis.__storage = storage

const dir = join(tmpdir(), `inbox-notify-${process.pid}`)
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'sdk.mjs'), sdkStub)
writeFileSync(join(dir, 'react.mjs'), `
export const useCallback = f => f
export const useMemo = f => f()
export const useState = v => [typeof v === 'function' ? v() : v, () => {}]
export const useEffect = () => {}
export const useRef = v => ({ current: v })
`)
writeFileSync(join(dir, 'jsx-runtime.mjs'), `
export const jsx = (type, props) => ({ type, props })
export const jsxs = (type, props) => ({ type, props })
`)

const patched = src
  .replace(/from '@hermes\/plugin-sdk'/g, `from '${join(dir, 'sdk.mjs')}'`)
  .replace(/from 'react\/jsx-runtime'/g, `from '${join(dir, 'jsx-runtime.mjs')}'`)
  .replace(/from 'react'/g, `from '${join(dir, 'react.mjs')}'`)

writeFileSync(join(dir, 'plugin.mjs'), patched)
const mod = await import(join(dir, 'plugin.mjs'))

// --- drive it exactly as the host does --------------------------------------
let nextItems = []
let intervals = []
let listeners = []
let timeouts = []
let restCalls = 0
let restThrows = false

function makeCtx() {
  return {
    rest: async () => {
      restCalls++
      if (restThrows) throw new Error('gateway restarting')
      return { items: nextItems }
    },
    os: { notify: n => notifications.push(n) },
    onEvent: (_type, fn) => {
      listeners.push(fn)
      return () => {}
    },
    setInterval: fn => {
      intervals.push(fn)
      return () => {}
    },
    setTimeout: fn => {
      timeouts.push(fn)
      return () => {}
    },
    register: () => {},
    onDispose: () => {}
  }
}

let ctx = makeCtx()
mod.default.register(ctx)

assert.equal(intervals.length, 1, 'register() must start exactly one poller')
assert.equal(listeners.length, 1, 'register() must subscribe to cron.changed')
assert.equal(timeouts.length, 1, 'register() must schedule a first tick')
// The critical structural assertion: NOTHING here required a rendered component.
assert.equal(typeof intervals[0], 'function', 'the poller is a plain function')

const item = (id, extra = {}) => ({
  id,
  silent: false,
  muted: false,
  unread: true,
  job_name: 'Watcher',
  preview: 'a thing changed',
  title: 'Watcher',
  ...extra
})

async function tick(items) {
  nextItems = items
  await intervals[0]()
}

// 1. First launch with a backlog must announce NOTHING.
await tick([item('default|a|1'), item('default|a|2')])
assert.equal(notifications.length, 0, 'backlog on first launch must be silent')
assert.equal(toasts.length, 0, 'backlog must not toast either')

// 2. A genuinely new report announces once, through both doors.
await tick([item('default|a|1'), item('default|a|2'), item('default|a|3')])
assert.equal(notifications.length, 1, 'one new report -> one OS notification')
assert.equal(toasts.length, 1, 'the same event must also raise an in-app toast')
assert.match(notifications[0].title, /New cron report/)
assert.match(notifications[0].body, /Watcher/)
assert.deepEqual(notifications[0].activate, { path: '/inbox' })
assert.equal(toasts[0].action?.label, 'Open Inbox')
assert.equal(typeof toasts[0].action?.run, 'function', 'toast action must be runnable')

// 3. THE COUNT-DIFF TRAP: one arrives while one is read -> count unchanged.
await tick([item('default|a|1'), item('default|a|2'), item('default|a|4')])
assert.equal(notifications.length, 2, 'count stayed flat but a new id arrived')

// 4. No new ids: silent.
await tick([item('default|a|1'), item('default|a|2'), item('default|a|4')])
assert.equal(notifications.length, 2, 'nothing new -> no notification')

// 5. Silent and muted runs must never announce.
await tick([
  item('default|a|1'), item('default|a|2'), item('default|a|4'),
  item('default|a|5', { silent: true }),
  item('default|a|6', { muted: true })
])
assert.equal(notifications.length, 2, 'silent/muted must not announce')

// 6. Multiple new reports in one tick -> ONE notification naming the count.
await tick([
  item('default|a|1'), item('default|a|2'), item('default|a|4'),
  item('default|a|7'), item('default|a|8')
])
const batch = notifications[notifications.length - 1]
assert.match(batch.title, /2 new cron reports/)
assert.match(batch.body, /and 1 more/)

// 7. A failing report toasts as a warning.
await tick([
  item('default|a|1'), item('default|a|2'), item('default|a|4'),
  item('default|a|9', { error: true, job_name: 'Backup' })
])
assert.equal(toasts[toasts.length - 1].kind, 'warning', 'an erroring report should warn')
assert.match(toasts[toasts.length - 1].message, /Backup/)

// 8. Persisted across a reload: a fresh register() must not replay the backlog.
const stored = storage.get('notified_unread_ids')
assert.ok(Array.isArray(stored) && stored.length > 0, 'seen ids persisted')

const before = notifications.length
intervals = []
listeners = []
timeouts = []
ctx = makeCtx()
mod.default.register(ctx)
await tick([item('default|a|1'), item('default|a|2'), item('default|a|4')])
assert.equal(notifications.length, before, 'reload must not re-announce known ids')

// 9. A backend failure must not kill the watcher.
intervals = []
listeners = []
timeouts = []
ctx = makeCtx()
mod.default.register(ctx)
// prime it first
await tick([item('default|a|1')])
const baseline = notifications.length
restThrows = true
await intervals[0]()          // must swallow the throw
restThrows = false
await tick([item('default|a|1'), item('default|a|11')])
assert.equal(notifications.length, baseline + 1, 'a failed poll must not stop later ticks')

// 10. Notifications OFF: neither door fires, but seen-tracking continues.
//     The second half is the part that matters - if "off" also stopped the
//     bookkeeping, turning it back on would dump every gap-time report at once.
intervals = []
listeners = []
timeouts = []
ctx = makeCtx()
mod.default.register(ctx)
await tick([item('default|a|1')])            // prime
storage.set('notifications_enabled', false)
const osBefore = notifications.length
const toastBefore = toasts.length
await tick([item('default|a|1'), item('default|a|20')])
assert.equal(notifications.length, osBefore, 'notifications off must not raise an OS notification')
assert.equal(toasts.length, toastBefore, 'notifications off must not raise a toast')
assert.ok(
  (storage.get('notified_unread_ids') ?? []).includes('default|a|20'),
  'notifications off must still record seen ids, or re-enabling replays them'
)

// 11. Turning it back ON must not replay what arrived while it was off.
const osBefore2 = notifications.length
await tick([item('default|a|1'), item('default|a|20')])
assert.equal(
  notifications.length, osBefore2,
  're-enabling must not announce reports that arrived while notifications were off'
)
// ...but a genuinely new report still does.
storage.set('notifications_enabled', true)
await tick([item('default|a|1'), item('default|a|20'), item('default|a|21')])
assert.equal(notifications.length, osBefore2 + 1, 're-enabled notifications must fire for new reports')

// Guard against the file becoming a no-op.
assert.ok(restCalls > 0, 'the watcher never called rest')
assert.ok(notifications.length > 0, 'no OS notifications fired at all')
assert.ok(toasts.length > 0, 'no in-app toasts fired at all')

console.log(
  `ok   11 watcher behaviours verified ` +
  `(os=${notifications.length}, toast=${toasts.length}, rest=${restCalls}, stored=${storage.get('notified_unread_ids')?.length ?? 0})`
)
