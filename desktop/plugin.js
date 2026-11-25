/**
 * Hermes Inbox — a reading surface for the cron run documents Hermes already
 * writes. No delivery, no webhooks, no per-job config: this page lists
 * `cron/output/<job>/<stamp>.md` across every profile, hides the runs that
 * said nothing, and remembers what you have read.
 *
 * Plain ESM, loaded uncompiled — UI is jsx() calls, not JSX syntax.
 * Only these imports resolve: @hermes/plugin-sdk, react, react/jsx-runtime.
 */

import {
  Badge,
  Button,
  Codicon,
  EmptyState,
  ErrorState,
  PALETTE_AREA,
  ROUTES_AREA,
  ScrollArea,
  SearchField,
  SegmentedControl,
  SIDEBAR_NAV_AREA,
  Skeleton,
  STATUSBAR_AREAS,
  MessageTextContent,
  cn,
  host,
  useQuery,
  useQueryClient
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const ID = 'hermes-cron-inbox'
const PATH = '/inbox'
const CHANGED_EVENT = 'cron.changed'

// The inbox is a view over files the scheduler writes in the background, so
// cron.changed (jobs.json moved: a tick's bookkeeping or CRUD) is the real
// signal and this poll is only a backstop. Same shape core's own Cron surfaces use.
// Overridable from the plugin's own settings (GET /config).
const DEFAULT_POLL_MS = 60_000

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'errors', label: 'Errors' }
]

const SCOPES = [
  { id: 'visible', label: 'Reported' },
  { id: 'everything', label: 'Everything' }
]

const LOCALES = {
  en: {
    nav: 'Inbox',
    title: 'Inbox',
    subtitle: jobs => (jobs === 1 ? '1 job' : `${jobs} jobs`),
    search: 'Search runs…',
    all: 'All',
    unread: 'Unread',
    errors: 'Errors',
    reported: 'Reported',
    everything: 'Everything',
    empty: 'Nothing to read',
    emptyHint: 'Watchers that found nothing stay hidden. Switch to Everything to see every run.',
    noMatch: 'No runs match this filter.',
    failed: 'Inbox unavailable',
    failedHint: 'The inbox backend did not answer. Is the plugin enabled in config.yaml?',
    markAll: 'Mark all read',
    markedAll: n => (n === 1 ? '1 run marked read' : `${n} runs marked read`),
    markRead: 'Mark read',
    markUnread: 'Mark unread',
    mute: 'Mute this job',
    unmute: 'Unmute',
    muted: 'Muted',
    error: 'Error',
    silent: 'Silent',
    orphan: 'deleted job',
    script: 'script',
    agent: 'agent',
    chars: n => `${n.toLocaleString()} chars`,
    back: 'Back to list',
    runAt: 'Run',
    schedule: 'Schedule',
    deliver: 'Delivers to',
    job: 'Job',
    mutedNote: 'Muted jobs are hidden until you unmute them or switch to Everything.',
    openAgentRun: 'This run belongs to an agent job — its transcript is on the Cron page.'
  }
}

function fmtTime(stamp) {
  if (!stamp) return ''
  // 2026-11-25_13-41-19 -> local time
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/.exec(stamp)
  if (!m) return stamp
  const d = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6])
  )
  return Number.isNaN(d.valueOf()) ? stamp : d.toLocaleString()
}

function relTime(stamp) {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/.exec(stamp || '')
  if (!m) return ''
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
  const secs = Math.round((Date.now() - d.valueOf()) / 1000)
  if (!Number.isFinite(secs) || secs < 0) return ''
  if (secs < 60) return 'now'
  if (secs < 3600) return `${Math.floor(secs / 60)}m`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`
  return `${Math.floor(secs / 86400)}d`
}

// Serialise the item filters into a real query string. `ctx.rest(['/items' + qs(p)'])`
// is the ONLY correct call: ctx.rest takes a PATH, so handing it the params
// object sends the request to `/api/plugins/<id>/[object Object]` and every
// read 404s (the page then sits in its error state after the retries).
function qs(params) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === false) continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

function useInbox(queryClient, params, pollMs) {
  const path = `/items${qs(params)}`
  const query = useQuery({
    queryKey: [ID, 'items', path],
    queryFn: () => ctxRest(path),
    refetchInterval: pollMs
  })

  useEffect(() => {
    return host.onEvent(CHANGED_EVENT, () => {
      queryClient.invalidateQueries({ queryKey: [ID] })
    })
  }, [queryClient])

  return query
}

// ctx is created per register() call; the request door is stable for the
// plugin's lifetime, so one module-level binding is safe and keeps the query
// functions out of the component tree.
let ctxRest = () => Promise.reject(new Error('inbox: ctx not bound yet'))

function ItemRow({ item, t, onOpen }) {
  const tone = item.error ? 'destructive' : item.unread ? 'default' : 'muted'

  return jsxs('button', {
    type: 'button',
    onClick: () => onOpen(item),
    className: cn(
      'group flex w-full items-start gap-3 rounded-md px-3 py-2 text-left transition-colors',
      'hover:bg-(--chrome-action-hover) focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40'
    ),
    children: [
      // Unread dot: the one thing that must scan at a glance.
      jsx('span', {
        className: cn(
          'mt-1.5 size-1.5 shrink-0 rounded-full',
          item.unread ? 'bg-(--ui-accent)' : 'bg-transparent'
        )
      }),
      jsxs('span', {
        className: 'flex min-w-0 flex-1 flex-col gap-0.5',
        children: [
          jsxs('span', {
            className: 'flex items-baseline gap-2',
            children: [
              jsx('span', {
                className: cn(
                  'truncate text-[0.8125rem]',
                  item.unread ? 'font-medium text-foreground' : 'text-(--ui-text-secondary)'
                ),
                children: item.job_name
              }),
              item.profile !== 'default'
                ? jsx('span', {
                    className: 'shrink-0 text-[0.62rem] text-(--ui-text-quaternary)',
                    children: item.profile
                  })
                : null,
              jsx('span', { className: 'flex-1' }),
              jsx('span', {
                className: 'shrink-0 text-[0.62rem] tabular-nums text-(--ui-text-quaternary)',
                title: fmtTime(item.stamp),
                children: relTime(item.stamp)
              })
            ]
          }),
          jsx('span', {
            className: 'line-clamp-2 text-xs leading-4 text-(--ui-text-tertiary)',
            children: item.preview || t('silent')
          }),
          item.error
            ? jsx('span', {
                className: 'mt-0.5 flex items-center gap-1 text-[0.62rem] text-destructive',
                children: [
                  jsx(Codicon, { name: 'warning', size: '0.625rem' }),
                  jsx('span', { children: item.status || t('error') })
                ]
              })
            : null
        ]
      })
    ]
  })
}

function Reader({ item, t, onBack, onRead, onMute }) {
  const detail = useQuery({
    queryKey: [ID, 'item', item.id],
    queryFn: () => ctxRest(`/items/${encodeURIComponent(item.id)}`),
    staleTime: 30_000
  })

  const body = detail.data?.body ?? ''
  const loading = detail.isLoading

  return jsxs('div', {
    className: 'flex h-full min-h-0 flex-col',
    children: [
      jsxs('div', {
        className: 'flex shrink-0 items-center gap-2 border-b border-(--ui-stroke-secondary) px-3 py-2',
        children: [
          jsxs(Button, {
            variant: 'ghost',
            size: 'sm',
            onClick: onBack,
            className: 'gap-1',
            children: [jsx(Codicon, { name: 'arrow-left', size: '0.75rem' }), t('back')]
          }),
          jsx('span', {
            className: 'truncate text-sm font-medium',
            children: item.job_name
          }),
          item.error
            ? jsx(Badge, { variant: 'destructive', children: t('error') })
            : null,
          item.profile !== 'default'
            ? jsx(Badge, { variant: 'outline', children: item.profile })
            : null,
          jsx('span', { className: 'flex-1' }),
          jsxs(Button, {
            variant: 'ghost',
            size: 'sm',
            onClick: () => onRead(item, !item.read),
            children: [item.read ? t('markUnread') : t('markRead')]
          }),
          jsxs(Button, {
            variant: 'ghost',
            size: 'sm',
            onClick: () => onMute(item, !item.muted),
            title: t('mute'),
            children: [
              jsx(Codicon, { name: item.muted ? 'bell-slash' : 'bell', size: '0.75rem' })
            ]
          })
        ]
      }),
      jsxs('div', {
        className: 'shrink-0 px-4 py-2 text-[0.6875rem] text-(--ui-text-quaternary)',
        children: [
          jsx('span', { children: `${t('runAt')}: ${fmtTime(item.stamp)}` }),
          item.schedule ? jsx('span', { children: ` · ${item.schedule}` }) : null,
          jsx('span', { children: ` · ${item.is_script ? t('script') : t('agent')}` }),
          jsx('span', { children: ` · ${t('chars', item.chars || body.length)}` }),
          item.deliver
            ? jsx('span', { children: ` · ${t('deliver')} ${item.deliver}` })
            : null
        ]
      }),
      jsx(ScrollArea, {
        className: 'min-h-0 flex-1',
        children: jsx('div', {
          className: 'px-4 pb-8 pt-1',
          children: loading
            ? jsxs('div', {
                className: 'flex flex-col gap-2',
                children: [
                  jsx(Skeleton, { className: 'h-4 w-2/3' }),
                  jsx(Skeleton, { className: 'h-4 w-full' }),
                  jsx(Skeleton, { className: 'h-4 w-5/6' })
                ]
              })
            : jsx(MessageTextContent, { text: body || item.preview || '' })
        })
      })
    ]
  })
}

function InboxPage({ ctx }) {
  const t = useLocale()
  const queryClient = useQueryClient()
  const settings = useQuery({
    queryKey: [ID, 'config'],
    queryFn: () => ctxRest('/config'),
    staleTime: 5 * 60_000
  })
  const pollMs = Math.max(10, Number(settings.data?.poll_seconds) || 60) * 1000

  const [filter, setFilter] = useState('all')
  // The plugin's own setting decides what the first open shows; the segmented
  // control still overrides it for the session.
  const [scope, setScope] = useState(null)
  const effectiveScope = scope ?? (settings.data?.include_silent_by_default ? 'everything' : 'visible')
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(null)
  const [deferred, setDeferred] = useState('')

  // Debounce the search box: a keystroke should not become a directory walk.
  useEffect(() => {
    const timer = setTimeout(() => setDeferred(search.trim()), 250)
    return () => clearTimeout(timer)
  }, [search])

  const params = useMemo(
    () => ({
      limit: 300,
      unread_only: filter === 'unread',
      errors_only: filter === 'errors',
      include_silent: effectiveScope === 'everything',
      include_muted: effectiveScope === 'everything',
      q: deferred
    }),
    [filter, effectiveScope, deferred]
  )

  const query = useInbox(queryClient, params, pollMs)

  const items = query.data?.items ?? []
  const unread = query.data?.unread ?? 0
  const jobCount = useMemo(() => new Set(items.map(i => `${i.profile}|${i.job_id}`)).size, [items])

  const markRead = useCallback(
    async (item, read) => {
      try {
        await ctxRest(`/items/${encodeURIComponent(item.id)}/read`, {
          method: 'POST',
          body: { read }
        })
      } catch (err) {
        host.notify({ kind: 'error', message: String(err?.message || err) })
      }
      queryClient.invalidateQueries({ queryKey: [ID] })
    },
    [queryClient]
  )

  const markMuted = useCallback(
    async (item, muted) => {
      try {
        await ctxRest(`/items/${encodeURIComponent(item.id)}/mute`, {
          method: 'POST',
          body: { muted }
        })
        if (open?.id === item.id) setOpen(null)
      } catch (err) {
        host.notify({ kind: 'error', message: String(err?.message || err) })
      }
      queryClient.invalidateQueries({ queryKey: [ID] })
    },
    [queryClient, open]
  )

  const markAll = useCallback(async () => {
    try {
      const res = await ctxRest(`/mark-all-read`, {
        method: 'POST',
        body: { include_silent: false }
      })
      host.notify({ kind: 'success', message: t('markedAll', res?.marked ?? 0) })
    } catch (err) {
      host.notify({ kind: 'error', message: String(err?.message || err) })
    }
    queryClient.invalidateQueries({ queryKey: [ID] })
  }, [queryClient, t])

  const openItem = useCallback(
    (item) => {
      setOpen(item)
      if (item.unread) void markRead(item, true)
    },
    [markRead]
  )

  if (open) {
    return jsx(Reader, {
      item: open,
      t,
      onBack: () => setOpen(null),
      onRead: markRead,
      onMute: markMuted
    })
  }

  return jsxs('div', {
    className: 'flex h-full min-h-0 flex-col',
    children: [
      jsxs('div', {
        className: 'flex shrink-0 flex-wrap items-center gap-2 px-3 py-2',
        children: [
          jsx('span', { className: 'text-sm font-medium', children: t('title') }),
          unread > 0
            ? jsx(Badge, { variant: 'solid', size: 'xs', children: unread })
            : null,
          jsx('span', { className: 'text-[0.6875rem] text-(--ui-text-quaternary)', children: t('subtitle', jobCount) }),
          jsx('span', { className: 'flex-1' }),
          unread > 0
            ? jsxs(Button, {
                variant: 'ghost',
                size: 'sm',
                onClick: markAll,
                className: 'gap-1',
                children: [jsx(Codicon, { name: 'check-all', size: '0.75rem' }), t('markAll')]
              })
            : null
        ]
      }),
      jsxs('div', {
        className: 'flex shrink-0 flex-wrap items-center gap-2 px-3 pb-2',
        children: [
          jsx(SegmentedControl, {
            options: FILTERS.map(f => ({ id: f.id, label: t(f.id) })),
            value: filter,
            onChange: setFilter,
            sizing: 'content'
          }),
          jsx(SegmentedControl, {
            options: SCOPES.map(s => ({ id: s.id, label: t(s.id) })),
            value: effectiveScope,
            onChange: setScope,
            sizing: 'content'
          }),
          jsx('span', { className: 'min-w-0 flex-1' }),
          jsx(SearchField, {
            placeholder: t('search'),
            value: search,
            onChange: setSearch,
            containerClassName: 'w-56'
          })
        ]
      }),
      jsx('div', { className: 'min-h-0 flex-1', children: renderList() })
    ]
  })

  function renderList() {
    if (query.isLoading && !query.data) {
      return jsx('div', {
        className: 'flex flex-col gap-1 px-3',
        children: [0, 1, 2, 3, 4].map(i =>
          jsx(Skeleton, { key: i, className: 'h-11 w-full rounded-md' })
        )
      })
    }
    if (query.isError) {
      return jsx('div', {
        className: 'grid h-full place-items-center px-6',
        children: jsx(ErrorState, {
          title: t('failed'),
          description: `${t('failedHint')}\n${String(query.error?.message || '')}`
        })
      })
    }
    if (!items.length) {
      return jsx(EmptyState, {
        title: t('empty'),
        description: deferred || filter !== 'all' ? t('noMatch') : t('emptyHint')
      })
    }
    return jsx(ScrollArea, {
      className: 'h-full',
      children: jsx('div', {
        className: 'flex flex-col gap-0.5 px-1 pb-6',
        children: items.map(item => jsx(ItemRow, { key: item.id, item, t, onOpen: openItem }))
      })
    })
  }
}

function useLocale() {
  // Strings are module-local; keeping the lookup behind a function means a
  // future locale bundle is a one-line change, and nothing reads a key that
  // does not exist.
  return useCallback((key, ...args) => {
    const entry = LOCALES.en[key]
    if (typeof entry === 'function') return entry(...args)
    return entry ?? key
  }, [])
}

function UnreadChip() {
  const t = useLocale()
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: [ID, 'summary'],
    queryFn: () => ctxRest('/summary'),
    refetchInterval: DEFAULT_POLL_MS
  })
  const count = query.data?.unread ?? 0
  const errors = query.data?.errors ?? 0

  useEffect(() => {
    return host.onEvent(CHANGED_EVENT, () => {
      // One shared client: invalidating the summary key never touches the
      // full item list another view is reading.
      void queryClient.invalidateQueries({ queryKey: [ID, 'summary'] })
    })
  }, [queryClient])



  if (!count && !errors) return null

  return jsx('button', {
    type: 'button',
    onClick: () => host.navigate(PATH),
    title: t('title'),
    className: cn(
      'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] transition-colors',
      'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
    ),
    children: [
      jsx(Codicon, {
        name: errors ? 'warning' : 'inbox',
        size: '0.75rem',
        className: errors ? 'text-destructive' : undefined
      }),
      jsx('span', { children: count })
    ]
  })
}

// ---------------------------------------------------------------------------
// OS notifications
// ---------------------------------------------------------------------------
//
// Fires a native notification when a report the user has not read appears.
// `ctx.os.notify` reaches Electron's Notification in the desktop app and the
// browser Notification API in the Webapp (the host picks the half by
// capabilities). It is gated by Settings -> Notifications -> "Plugin
// notifications" (on by default) and the host already suppresses it while you
// are looking at Hermes, so this deliberately does not guess focus itself.
//
// The Webapp half needs a SECURE CONTEXT: https or localhost. On a plain-http
// LAN address the permission reads 'insecure' and nothing shows - which is part
// of why hermes.quietforge.vip exists.
//
// Design note: track the SET of unread item ids, not the count. A count can stay
// flat while one report arrives and another is read, so a count diff would miss
// the new one (or re-announce an old one). Ids are content-addressed
// (profile|job_id|stamp), so the comparison is stable across restarts.

const NOTIFY_BODY_MAX = 120
const NOTIFY_STORE_KEY = 'notified_unread_ids'

function loadNotifiedIds() {
  try {
    const raw = host.storage.get(NOTIFY_STORE_KEY, [])
    return Array.isArray(raw) ? raw.filter(x => typeof x === 'string') : []
  } catch {
    return []
  }
}

function saveNotifiedIds(ids) {
  try {
    // Bounded: only the newest matter for de-duplication and this must never
    // grow without limit.
    host.storage.set(NOTIFY_STORE_KEY, ids.slice(0, 500))
  } catch {
    /* storage is best-effort; never break the chip over it */
  }
}

function summarise(items) {
  const first = items[0]
  if (!first) return ''

  const name = first.job_name || first.title || 'A job'

  if (items.length === 1) {
    const preview = String(first.preview || '').replace(/\s+/g, ' ').trim()
    return preview ? `${name}: ${preview}`.slice(0, NOTIFY_BODY_MAX) : name
  }

  return `${name} and ${items.length - 1} more`
}

function CronNotifier() {
  const queryClient = useQueryClient()
  // Seeded from the FIRST successful poll, not from empty: whatever is already
  // unread when the app opens is not news, and announcing a backlog of 50+ on
  // every launch is the fastest way to get notifications switched off.
  const primed = useRef(false)
  const seen = useRef(new Set())

  const query = useQuery({
    queryKey: [ID, 'notify-scan'],
    queryFn: () => ctxRest('/items?unread_only=true&limit=200'),
    refetchInterval: DEFAULT_POLL_MS
  })

  useEffect(() => {
    return host.onEvent(CHANGED_EVENT, () => {
      void queryClient.invalidateQueries({ queryKey: [ID, 'notify-scan'] })
    })
  }, [queryClient])

  useEffect(() => {
    const items = query.data?.items
    if (!Array.isArray(items)) return

    // The chip and the list both hide silent and muted runs; the notifier must
    // agree or it would announce things the page refuses to show.
    const unread = items.filter(item => !item.silent && !item.muted)
    const ids = unread.map(item => item.id)

    if (!primed.current) {
      const stored = loadNotifiedIds()
      seen.current = new Set(stored.length ? stored : ids)
      primed.current = true
      if (!stored.length) saveNotifiedIds(ids)
      return
    }

    const known = seen.current
    const fresh = unread.filter(item => !known.has(item.id))

    if (!fresh.length) {
      // Reading items removes them from the unread list; drop them from `known`
      // too so the set tracks reality instead of growing forever.
      const live = new Set(ids)
      let shrunk = false
      for (const id of [...known]) {
        if (!live.has(id)) {
          known.delete(id)
          shrunk = true
        }
      }
      if (shrunk) saveNotifiedIds([...known])
      return
    }

    for (const item of fresh) known.add(item.id)
    saveNotifiedIds([...known])

    host.os.notify({
      title: fresh.length === 1 ? 'New cron report' : `${fresh.length} new cron reports`,
      body: summarise(fresh),
      activate: { path: PATH }
    })
  }, [query.data])

  return null
}

/**
 * The statusbar slot is the one surface mounted on every view, so the watcher
 * lives here. `UnreadChip` returns null at zero, which is why the notifier is a
 * sibling rather than a child - a null return would otherwise unmount the
 * watcher the moment the count hit zero.
 */
function StatusbarSlot() {
  return jsxs('span', {
    className: 'inline-flex h-full items-center',
    children: [jsx(CronNotifier, {}), jsx(UnreadChip, {})]
  })
}

export default {
  id: ID,
  name: 'hermes-cron-inbox',
  register(ctx) {
    ctxRest = (path, opts) => ctx.rest(path, opts)

    ctx.register({
      id: 'page',
      area: ROUTES_AREA,
      data: { path: PATH },
      render: () => jsx(InboxPage, { ctx })
    })

    ctx.register({
      id: 'nav',
      area: SIDEBAR_NAV_AREA,
      data: { path: PATH, label: 'Cron Inbox', codicon: 'inbox' }
    })

    ctx.register({
      id: 'chip',
      area: STATUSBAR_AREAS.right,
      order: 75,
      render: () => jsx(StatusbarSlot, {})
    })

    ctx.register({
      id: 'palette',
      area: PALETTE_AREA,
      data: {
        id: `${ID}.open`,
        label: 'Open Cron Inbox',
        keywords: ['inbox', 'cron', 'runs', 'reports', 'watchers'],
        run: () => host.navigate(PATH)
      }
    })
  }
}
