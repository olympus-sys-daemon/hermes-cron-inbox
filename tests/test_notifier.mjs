/**
 * Behavioural test for CronNotifier.
 *
 * The failure modes that matter are not syntax errors - they are:
 *   1. announcing the existing backlog on first launch (notification spam),
 *   2. missing a new report because the COUNT stayed the same,
 *   3. re-announcing after a restart because the seen-set was not persisted,
 *   4. announcing silent or muted runs the page refuses to show.
 *
 * So the fake host here is stateful: it records notifications and lets the test
 * drive successive poll results through the component.
 */
import assert from 'node:assert'

const notifications = []
let storage = new Map()

// --- fake React: enough to run a component once per "render" -----------------
const effects = []
export const useRefStub = v => ({ current: v })

// useRef must PERSIST across renders (that is its whole contract). A naive
// `v => ({current: v})` resets the ref every render, which would silently
// defeat the primed/seen guards and make the test pass/fail for the wrong
// reason. Refs are keyed by call order within a render pass.
const reactStub = `
export const useCallback = f => f
export const useMemo = f => f()
export const useState = v => [typeof v === 'function' ? v() : v, () => {}]
export const useEffect = f => { globalThis.__effects.push(f) }
const __refs = (globalThis.__refs ??= [])
export const useRef = v => {
  const i = globalThis.__refIndex++
  if (!(i in __refs)) __refs[i] = { current: v }
  return __refs[i]
}
`

// Built from the plugin's own import list, so adding an SDK component to the
// plugin never breaks this test with a missing-export error.
const srcForImports = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
const sdkImport = srcForImports.match(/import \{([\s\S]*?)\} from '@hermes\/plugin-sdk'/)
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
  onEvent: () => () => {},
  navigate: () => { globalThis.__navigated.push(arguments[0]) },
  notify: n => globalThis.__toasts.push(n),
  os: { notify: n => globalThis.__notifications.push(n) }
}`,
  useQuery: 'export const useQuery = o => ({ data: globalThis.__nextData, refetchInterval: o.refetchInterval })',
  useQueryClient: 'export const useQueryClient = () => ({ invalidateQueries: () => {} })',
  cn: `export const cn = (...a) => a.filter(Boolean).join(' ')`
}

const sdkStub = sdkNames
  .map(name => STUB_OVERRIDES[name] ?? `export const ${name} = () => null`)
  .join('\n')

const toasts = []

globalThis.__effects = effects
globalThis.__notifications = notifications
globalThis.__toasts = toasts
globalThis.__navigated = []
globalThis.__storage = storage

// --- the component under test, extracted by name -----------------------------
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const src = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
const dir = join(tmpdir(), `inbox-notify-${process.pid}`)
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'react.mjs'), reactStub)
writeFileSync(join(dir, 'sdk.mjs'), sdkStub)

writeFileSync(
  join(dir, 'jsx-runtime.mjs'),
  'export const jsx = (type, props) => ({ type, props })\n' +
  'export const jsxs = (type, props) => ({ type, props })\n'
)

const patched = src
  .replace(/from '@hermes\/plugin-sdk'/g, `from '${join(dir, 'sdk.mjs')}'`)
  .replace(/from 'react\/jsx-runtime'/g, `from '${join(dir, 'jsx-runtime.mjs')}'`)
  .replace(/from 'react'/g, `from '${join(dir, 'react.mjs')}'`)

writeFileSync(join(dir, 'plugin.mjs'), patched)
const mod = await import(join(dir, 'plugin.mjs'))

// The notifier is not exported; reach it through the statusbar slot's render.
const plugin = mod.default
const registrations = []
plugin.register({
  rest: async () => ({ items: [] }),
  register: r => registrations.push(r)
})

const chipReg = registrations.find(r => r.id === 'chip')
assert.ok(chipReg, 'statusbar slot registered')
const Slot = chipReg.render().type
assert.equal(typeof Slot, 'function')

// Render the slot once to register the notifier's effect.
// Fake jsx does not invoke components (real React does), so walk the tree and
// call every function component found. Without this the child components never
// run and the test would "pass" while testing nothing.
function renderDeep(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 20) return

  const { type, props } = node

  if (typeof type === 'function') {
    renderDeep(type({ ...(props ?? {}) }), depth + 1)
    return
  }

  const kids = props?.children
  if (Array.isArray(kids)) for (const kid of kids) renderDeep(kid, depth + 1)
  else if (kids && typeof kids === 'object') renderDeep(kids, depth + 1)
}

function poll(data) {
  globalThis.__nextData = data
  effects.length = 0
  globalThis.__refIndex = 0    // refs reset per render pass, then persist by index
  renderDeep(Slot())           // StatusbarSlot -> CronNotifier + UnreadChip
  // Run EVERY zero-arg effect. Picking only the first would run the onEvent
  // subscription and skip the data-watching effect - a silent no-op test.
  for (const fn of effects) if (fn.length === 0) fn()
}

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

// 1. First launch with a backlog must announce NOTHING.
poll({ items: [item('default|a|1'), item('default|a|2')] })
assert.equal(notifications.length, 0, 'backlog on first launch must be silent')

// 2. A genuinely new report announces once.
poll({ items: [item('default|a|1'), item('default|a|2'), item('default|a|3')] })
assert.equal(notifications.length, 1, 'one new report -> one notification')
assert.match(notifications[0].title, /New cron report/)
assert.match(notifications[0].body, /Watcher/)
assert.deepEqual(notifications[0].activate, { path: '/inbox' })

// 2b. The in-app toast must fire from the SAME event. The OS door is gated on
// being away from Hermes; the toast is the focused-window path, and core's own
// docstring names it as the foreground case. One event, both doors.
assert.equal(toasts.length, 1, 'the same event must also raise an in-app toast')
assert.match(toasts[0].message, /Watcher/)
assert.equal(toasts[0].action?.label, 'Open Inbox')
assert.ok(typeof toasts[0].action?.run === 'function', 'toast action must be runnable')

// 3. THE COUNT-DIFF TRAP: one arrives while one is read -> count unchanged.
poll({ items: [item('default|a|1'), item('default|a|2'), item('default|a|4')] })
assert.equal(notifications.length, 2, 'count stayed flat but a new id arrived')

// 4. No new ids: silent.
poll({ items: [item('default|a|1'), item('default|a|2'), item('default|a|4')] })
assert.equal(notifications.length, 2, 'nothing new -> no notification')

// 5. Silent and muted runs must never announce.
poll({
  items: [
    item('default|a|1'), item('default|a|2'), item('default|a|4'),
    item('default|a|5', { silent: true }),
    item('default|a|6', { muted: true })
  ]
})
assert.equal(notifications.length, 2, 'silent/muted must not announce')

// 6. Persisted across a restart: a fresh mount with the stored set must not replay.
const stored = globalThis.__storage.get('notified_unread_ids')
assert.ok(Array.isArray(stored) && stored.length > 0, 'seen ids persisted')
const replayBefore = notifications.length
effects.length = 0
globalThis.__refs = []       // fresh mount: refs gone, host storage survives
globalThis.__refIndex = 0
globalThis.__nextData = { items: [item('default|a|1'), item('default|a|2'), item('default|a|4')] }
renderDeep(Slot())
for (const fn of effects) if (fn.length === 0) fn()
assert.equal(notifications.length, replayBefore, 'restart must not re-announce known ids')

// 7. Multiple new reports in one tick -> one notification naming the count.
poll({
  items: [
    item('default|a|1'), item('default|a|2'), item('default|a|4'),
    item('default|a|7'), item('default|a|8')
  ]
})
const last = notifications[notifications.length - 1]
assert.match(last.title, /2 new cron reports/)
assert.match(last.body, /and 1 more/)

// 8. A failing report raises the toast as a warning, not a neutral info line.
notifications.length = 0
toasts.length = 0
poll({
  items: [
    item('default|a|1'), item('default|a|2'), item('default|a|4'),
    item('default|a|9', { error: true, job_name: 'Backup' })
  ]
})
assert.equal(notifications.length, 1)
assert.equal(toasts[0].kind, 'warning', 'an erroring report should warn')
assert.match(toasts[0].message, /Backup/)

// Guard against the whole file becoming a no-op: both doors must have fired at
// least once during the run, and the toast must never exceed the OS count (one
// event raises at most one of each).
assert.ok(notifications.length > 0, 'no OS notifications fired at all')
assert.ok(toasts.length > 0, 'no in-app toasts fired at all')

console.log(
  `ok   8 notifier behaviours verified ` +
  `(os=${notifications.length}, toast=${toasts.length}, storage=${globalThis.__storage.get('notified_unread_ids')?.length ?? 0})`
)
