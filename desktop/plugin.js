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
// Core's cron page. Not exported by the SDK and not gated by interface mode, so
// a plain navigate is the supported way in.
const CRON_PATH = '/cron'
const CHANGED_EVENT = 'cron.changed'

// The inbox is a view over files the scheduler writes in the background, so
// cron.changed (jobs.json moved: a tick's bookkeeping or CRUD) is the real
// signal and this poll is only a backstop. Same shape core's own Cron surfaces use.
// Overridable from the plugin's own settings (GET /config).
const DEFAULT_POLL_MS = 60_000

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'errors', label: 'Errors' },
  // Without this, muting a job removes it from the page with no way back: the
  // mute lives on the RUNS, so the card simply stops appearing.
  { id: 'muted', label: 'Muted' }
]

const LOCALES = {
  en: {
    nav: 'Inbox',
    title: 'Cron Inbox',
    subtitle: jobs => (jobs === 1 ? '1 job reporting' : `${jobs} jobs reporting`),
    search: 'Search reports…',
    all: 'All',
    unread: 'Unread',
    errors: 'Errors',
    new: 'New',
    history: 'History',
    openFull: 'Click to open this report in full',
    showFull: 'Show full report',
    showLess: 'Show less',
    emptyRun: 'This run reported nothing — a scheduled check that had nothing to say.',
    runsCount: n => (n === 1 ? '1 run' : `${n} runs`),
    reported: 'Reported',
    everything: 'Everything',
    empty: 'Nothing to read',
    emptyHint: 'Watchers that found nothing stay hidden. Switch to Everything to see every run.',
    noMatch: 'No runs match this filter.',
    failed: 'Inbox unavailable',
    failedHint: 'The inbox backend did not answer. Is the plugin enabled in config.yaml?',
    staleHost: 'Plugin needs a gateway restart',
    staleHint:
      'This plugin added a new endpoint, but the running gateway still has the old routes loaded. ' +
      'Restart the gateway (or the app) and this page will work. Approving an update is enough — ' +
      'nothing is broken on disk.',
    markAll: 'Mark all read',
    scheduledJobs: 'Scheduled jobs',
    openScheduled: 'Open the Scheduled jobs page',
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


// ctx is created per register() call; the request door is stable for the
// plugin's lifetime, so one module-level binding is safe and keeps the query
// functions out of the component tree.
let ctxRest = () => Promise.reject(new Error('inbox: ctx not bound yet'))

// ---------------------------------------------------------------------------
// Dashboard: one card per job, carrying the actual message
// ---------------------------------------------------------------------------
//
// The first version was a list of runs - one row per document, a two-line
// preview, everything else behind a click. That is a log viewer, and it made the
// reader do the work: to learn what a watcher currently says you had to open a
// row, remember it, go back, open the next.
//
// This is the other shape. One card per JOB, showing its newest reported run in
// full (up to a budget), with the counts and the recent-run dots on the header.
// Reading the page is the same act as reading the reports - a click is only for
// history or the untruncated text.

/** A card's body: monospace, preserved line breaks, clamped to a line budget. */
/**
 * A card's report text, and the way into the full view.
 *
 * Clicking the text opens the run in the reader. That is deliberately NOT a
 * plain `onClick` on the whole block: a click is also how you start selecting
 * text, so a naive handler makes the body unselectable - you drag to copy and
 * get a page transition instead.
 *
 * The rule used here: open only when the click did not produce a selection and
 * did not end one. `getSelection()` is read on mouseup, after the browser has
 * settled the selection, and an existing non-empty selection means the user was
 * copying, not navigating.
 */
function CardBody({ body, clamped, expanded, onToggle, onOpen, t }) {
  const [hovered, setHovered] = useState(false)

  const handleClick = useCallback(() => {
    // Read the selection at click time: a drag-select that ends inside the block
    // fires click too, and that must not navigate.
    const selection = typeof window !== 'undefined' ? window.getSelection?.() : null
    if (selection && String(selection).length > 0) return
    onOpen()
  }, [onOpen])

  return jsxs('div', {
    className: 'relative',
    children: [
      jsx('div', {
        key: 'text',
        role: 'button',
        tabIndex: 0,
        onClick: handleClick,
        onKeyDown: e => {
          // Keyboard users get Enter/Space; there is no selection to respect,
          // and Ctrl/Cmd+A then copy still works because the text is real text.
          if (e.key === 'Enter') {
            e.preventDefault()
            onOpen()
          }
        },
        onMouseEnter: () => setHovered(true),
        onMouseLeave: () => setHovered(false),
        title: t('openFull'),
        className: cn(
          // `select-text` is explicit: some ancestors in a clickable card set
          // user-select:none, and the report body must remain copyable.
          'cursor-pointer select-text whitespace-pre-wrap break-words rounded-sm',
          'text-[0.75rem] leading-[1.5] text-(--ui-text-primary)',
          'transition-colors hover:bg-(--ui-row-hover-background)',
          // The clamp is an inline style, not a Tailwind class: arbitrary
          // variants like `line-clamp-[14]` are compiled from CORE source only,
          // so a plugin-invented class silently does nothing. This is a real
          // scroll container instead, which also keeps the text selectable.
          clamped && !expanded ? 'overflow-hidden' : ''
        ),
        style: clamped && !expanded ? { maxHeight: '19em' } : undefined,
        // Runs are plain text with markdown-ish furniture; preserving whitespace
        // keeps the aligned columns of script reports readable.
        children: body
      }),
      clamped
        ? jsxs('button', {
            key: 'toggle',
            type: 'button',
            // The expander must not also navigate: stop the click reaching any
            // ancestor handler.
            onClick: event => {
              event.stopPropagation()
              onToggle()
            },
            className: cn(
              'mt-1 flex items-center gap-1 text-[0.6875rem] text-(--ui-text-secondary)',
              'transition-colors hover:text-foreground'
            ),
            children: [
              jsx(Codicon, { name: expanded ? 'chevron-up' : 'chevron-down', size: '0.625rem' }),
              jsx('span', { children: expanded ? t('showLess') : t('showFull') })
            ]
          })
        : null
    ]
  })
}

/** The little run-history dots: one per recent run, coloured by outcome. */
/**
 * Run history at a glance, and the way to open any one of them.
 *
 * These were decoration: you could see six runs existed but open none but the
 * newest. They are buttons now, and each carries its own outcome, because a
 * silent run is a legitimate click target that lands on an empty reader.
 */
function RunDots({ recent, limit = 8, onPick, t }) {
  const shown = recent.slice(0, limit)
  if (!shown.length) return null

  return jsx('span', {
    className: 'flex items-center gap-1',
    children: shown.map(run =>
      jsx('button', {
        key: run.id,
        type: 'button',
        onClick: event => {
          event.stopPropagation()
          onPick(run)
        },
        title: `${fmtTime(run.stamp)}${run.error ? ` · ${t('error')}` : run.silent ? ` · ${t('silent')}` : ''}`,
        className: cn(
          // `hover:scale-150` is not a generated class either; scale-110 exists.
          'h-2 w-2 shrink-0 rounded-full transition-transform hover:scale-110',
          run.error
            ? 'bg-destructive'
            : run.silent
              ? 'bg-(--ui-stroke-tertiary)'
              : run.unread
                ? 'bg-(--ui-accent)'
                : 'bg-(--ui-text-tertiary)/60'
        )
      })
    )
  })
}

function JobCard({ card, t, onOpenHistory, onMarkJobRead, onMute, onRaw, onPickRun }) {
  const [expanded, setExpanded] = useState(false)

  const badge = card.error
    ? jsx(Badge, { variant: 'destructive', size: 'xs', children: t('error') })
    : card.unread
      ? jsx('span', {
          className: 'flex items-center gap-1 text-[0.625rem] font-medium text-(--ui-accent)',
          children: [
            jsx('span', { className: 'h-1.5 w-1.5 rounded-full bg-(--ui-accent)' }),
            jsx('span', { children: t('new') })
          ]
        })
      : null

  return jsxs('article', {
    className: cn(
      'group relative flex flex-col gap-2 rounded-lg border px-3 py-2.5 transition-colors',
      'border-(--ui-stroke-secondary) bg-(--ui-bg-secondary)',
      card.error ? 'ring-1 ring-destructive/25' : ''
    ),
    children: [
      // ---- header ----------------------------------------------------------
      jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          jsx('span', {
            className: cn(
              'truncate text-[0.8125rem]',
              card.unread ? 'font-semibold text-foreground' : 'font-medium text-(--ui-text-secondary)'
            ),
            children: card.job_name
          }),
          badge,
          card.orphan
            ? jsx(Badge, { variant: 'outline', size: 'xs', children: t('orphan') })
            : null,
          card.profile !== 'default'
            ? jsx(Badge, { variant: 'outline', size: 'xs', children: card.profile })
            : null,
          jsx('span', { className: 'flex-1' }),
          jsx(RunDots, {
            recent: card.recent,
            t,
            onPick: run => onPickRun(card, run.id)
          }),
          jsx('span', {
            className: 'shrink-0 text-[0.6875rem] tabular-nums text-(--ui-text-tertiary)',
            title: fmtTime(card.stamp),
            children: relTime(card.stamp)
          })
        ]
      }),

      // ---- the message -----------------------------------------------------
      card.body
        ? jsx(CardBody, {
            body: card.body,
            t,
            clamped: card.chars > card.body.length || card.truncated,
            expanded,
            onToggle: () => setExpanded(v => !v),
            onOpen: () => onRaw(card)
          })
        : jsx('div', {
            className: 'text-xs italic text-(--ui-text-tertiary)',
            children: t('silent')
          }),

      // ---- footer ----------------------------------------------------------
      jsxs('div', {
        className: 'flex flex-wrap items-center gap-2 text-[0.6875rem] text-(--ui-text-tertiary)',
        children: [
          card.schedule ? jsx('span', { children: card.schedule }) : null,
          jsx('span', { children: `· ${card.is_script ? t('script') : t('agent')}` }),
          jsx('span', {
            children: `· ${card.runs === 1 ? '1 run' : `${card.runs} runs`}`
          }),
          card.unread_runs > 0
            ? jsx('span', {
                className: 'text-(--ui-accent)',
                children: `· ${card.unread_runs} unread`
              })
            : null,
          card.error_runs > 0
            ? jsx('span', {
                className: 'text-destructive',
                children: `· ${card.error_runs} failed`
              })
            : null,
          jsx('span', { className: 'flex-1' }),
          // Actions stay out of the way until the card is hovered or focused, so
          // the resting state is text rather than chrome.
          jsxs('div', {
            className: 'flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100',
            children: [
              card.unread
                ? jsx('button', {
                    type: 'button',
                    onClick: () => onMarkJobRead(card),
                    className: 'rounded px-1 py-0.5 transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground',
                    children: t('markRead')
                  })
                : null,
              jsx('button', {
                type: 'button',
                onClick: () => onOpenHistory(card),
                className: 'rounded px-1 py-0.5 transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground',
                children: t('history')
              }),
              jsx('button', {
                type: 'button',
                onClick: () => onMute(card, !card.muted),
                title: card.muted ? t('unmute') : t('mute'),
                className: 'rounded px-1 py-0.5 transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground',
                children: jsx(Codicon, { name: card.muted ? 'bell-slash' : 'bell', size: '0.6875rem' })
              })
            ]
          })
        ]
      })
    ]
  })
}

/**
 * The run history for one job: every run, newest first, each openable.
 *
 * Silent runs are listed too, marked as such - hiding them would make the list
 * disagree with the dot row, and "where did the 19:04 run go?" is the question
 * this page exists to answer.
 */
function HistoryPanel({ job, t, onOpen, onBack }) {
  const runs = useQuery({
    queryKey: [ID, 'history', job.profile, job.job_id],
    queryFn: () =>
      ctxRest(
        `/items?profile=${encodeURIComponent(job.profile)}` +
          `&job_id=${encodeURIComponent(job.job_id)}` +
          `&include_silent=true&include_muted=true&limit=200`
      ),
    staleTime: 15_000
  })

  const rows = runs.data?.items ?? []

  return jsxs('div', {
    className: 'flex h-full min-h-0 flex-col',
    children: [
      jsxs('div', {
        className:
          'flex shrink-0 items-center gap-2 border-b border-(--ui-stroke-secondary) px-3 py-2',
        children: [
          jsxs(Button, {
            variant: 'ghost',
            size: 'sm',
            onClick: onBack,
            className: 'gap-1',
            children: [jsx(Codicon, { name: 'arrow-left', size: '0.75rem' }), t('back')]
          }),
          jsx('span', { className: 'truncate text-sm font-medium', children: job.job_name }),
          jsx('span', {
            className: 'text-[0.6875rem] text-(--ui-text-tertiary)',
            children: t('runsCount', rows.length)
          })
        ]
      }),
      jsx(ScrollArea, {
        className: 'min-h-0 flex-1',
        children: runs.isLoading
          ? jsx('div', {
              className: 'flex flex-col gap-1 px-3 pt-2',
              children: [0, 1, 2, 3].map(i =>
                jsx(Skeleton, { key: i, className: 'h-10 w-full rounded-md' })
              )
            })
          : jsx('div', {
              className: 'flex flex-col gap-0.5 px-1 py-1',
              children: rows.map(run =>
                jsxs(
                  'button',
                  {
                    key: run.id,
                    type: 'button',
                    onClick: () => onOpen(run),
                    className: cn(
                      'flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left',
                      'transition-colors hover:bg-(--chrome-action-hover)'
                    ),
                    children: [
                      jsx('span', {
                        className: cn(
                          'w-1.5 shrink-0 self-center rounded-full',
                          run.error
                            ? 'h-1.5 bg-destructive'
                            : run.silent
                              ? 'h-1.5 bg-(--ui-stroke-tertiary)'
                              : 'h-1.5 bg-(--ui-accent)'
                        )
                      }),
                      jsx('span', {
                        className: cn(
                          'shrink-0 text-[0.6875rem] tabular-nums',
                          'text-(--ui-text-secondary)'
                        ),
                        children: fmtTime(run.stamp)
                      }),
                      jsx('span', {
                        className: cn(
                          'min-w-0 flex-1 truncate text-xs',
                          run.silent
                            ? 'italic text-(--ui-text-tertiary)'
                            : 'text-(--ui-text-primary)'
                        ),
                        children: run.silent ? t('silent') : run.preview || ''
                      }),
                      run.unread
                        ? jsx('span', {
                            key: 'u',
                            className: 'shrink-0 text-[0.625rem] text-(--ui-accent)',
                            children: t('new')
                          })
                        : null
                    ]
                  },
                  run.id
                )
              )
            })
      })
    ]
  })
}

/** One run, opened from a card's history. Keeps the old reader. */
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
          item.error ? jsx(Badge, { variant: 'destructive', children: t('error') }) : null,
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
        className: 'shrink-0 px-4 py-2 text-[0.6875rem] text-(--ui-text-tertiary)',
        children: [
          jsx('span', { children: `${t('runAt')}: ${fmtTime(item.stamp)}` }),
          item.schedule ? jsx('span', { children: ` · ${item.schedule}` }) : null,
          jsx('span', { children: ` · ${item.is_script ? t('script') : t('agent')}` }),
          jsx('span', { children: ` · ${t('chars', item.chars || body.length)}` }),
          item.deliver ? jsx('span', { children: ` · ${t('deliver')} ${item.deliver}` }) : null
        ]
      }),
      jsx(ScrollArea, {
        className: 'min-h-0 flex-1',
        children: jsx('div', {
          // `select-text` is explicit: the full view is where people copy a
          // report out, and a clickable ancestor must not take that away.
          className: 'select-text px-4 pb-8 pt-1',
          children: loading
            ? jsxs('div', {
                className: 'flex flex-col gap-2',
                children: [
                  jsx(Skeleton, { className: 'h-4 w-1/2' }),
                  jsx(Skeleton, { className: 'h-4 w-full' }),
                  jsx(Skeleton, { className: 'h-4 w-1/2' })
                ]
              })
            : body || item.preview
              ? jsx(MessageTextContent, { text: body || item.preview })
              : jsx('div', {
                  // A blank pane reads as a bug. A silent run legitimately has no
                  // body, so the reader must say which it is.
                  className: 'flex flex-col gap-1 py-6 text-xs text-(--ui-text-tertiary)',
                  children: [
                    jsx('span', { key: 'note', children: t('emptyRun') }),
                    jsx('span', {
                      key: 'when',
                      className: 'text-(--ui-text-secondary)',
                      children: `${t('runAt')}: ${fmtTime(item.stamp)}`
                    })
                  ]
                })
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
  const [search, setSearch] = useState('')
  const [deferred, setDeferred] = useState('')
  const [open, setOpen] = useState(null)
  // A job whose run list is showing. Distinct from `open` (one run).
  const [history, setHistory] = useState(null)

  // Debounce the search box: a keystroke should not become a directory walk.
  useEffect(() => {
    const timer = setTimeout(() => setDeferred(search.trim()), 250)
    return () => clearTimeout(timer)
  }, [search])

  const params = useMemo(
    () => ({
      limit: 60,
      // The card budget is a declared setting; the server clamps it.
      body_limit: Number(settings.data?.body_limit) || 1200,
      unread_only: filter === 'unread',
      errors_only: filter === 'errors',
      muted_only: filter === 'muted',
      include_silent: false,
      // The Muted tab must see muted jobs; every other tab must not.
      include_muted: filter === 'muted',
      q: deferred
    }),
    [filter, deferred, settings.data?.body_limit]
  )

  const feed = useQuery({
    queryKey: [ID, 'feed', qs(params)],
    queryFn: () => ctxRest(`/feed${qs(params)}`),
    refetchInterval: pollMs
  })

  useEffect(() => {
    return host.onEvent(CHANGED_EVENT, () => {
      void queryClient.invalidateQueries({ queryKey: [ID, 'feed'] })
    })
  }, [queryClient])

  const cards = feed.data?.cards ?? []
  const unread = feed.data?.unread ?? 0
  const errors = feed.data?.errors ?? 0

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: [ID] })
  }, [queryClient])

  const markJobRead = useCallback(
    async card => {
      try {
        // Marking a job read means marking its unread runs read; the card is a
        // projection, so it cannot carry a single row's state.
        await Promise.all(
          card.recent
            .filter(r => r.unread)
            .map(r =>
              ctxRest(`/items/${encodeURIComponent(r.id)}/read`, {
                method: 'POST',
                body: { read: true }
              })
            )
        )
      } catch (err) {
        host.notify({ kind: 'error', message: String(err?.message || err) })
      }
      refresh()
    },
    [refresh]
  )

  const markMuted = useCallback(
    async (card, muted) => {
      try {
        // Job-level: muting only the newest run left the job half-hidden and
        // reappearing as older runs surfaced.
        await ctxRest(
          `/jobs/${encodeURIComponent(card.profile)}/${encodeURIComponent(card.job_id)}/mute`,
          { method: 'POST', body: { muted } }
        )
        host.notify({
          kind: 'success',
          message: muted
            ? `${card.job_name} muted — find it under Muted`
            : `${card.job_name} unmuted`
        })
      } catch (err) {
        host.notify({ kind: 'error', message: String(err?.message || err) })
      }
      refresh()
    },
    [refresh]
  )

  const markAll = useCallback(async () => {
    try {
      const res = await ctxRest('/mark-all-read', {
        method: 'POST',
        body: { include_silent: false }
      })
      host.notify({ kind: 'success', message: t('markedAll', res?.marked ?? 0) })
    } catch (err) {
      host.notify({ kind: 'error', message: String(err?.message || err) })
    }
    refresh()
  }, [refresh, t])

  /**
   * Open one run in the reader.
   *
   * `runId` matters: the card's body comes from the newest REPORTED run, while
   * `recent[0]` is the newest run of ANY kind. A watcher whose last tick was
   * silent therefore has a card full of text and a `recent[0]` that is empty -
   * clicking it opened a blank reader (or a literal `[SILENT]`). Every caller
   * must name the run it means.
   */
  const openRun = useCallback(
    (card, runId) => {
      const run =
        card.recent.find(r => r.id === runId) ??
        card.recent.find(r => r.id === card.latest_id) ??
        card.recent[0]
      if (!run) return
      setOpen({
        id: run.id,
        job_name: card.job_name,
        profile: card.profile,
        stamp: run.stamp,
        error: run.error,
        muted: card.muted,
        read: !run.unread,
        schedule: card.schedule,
        is_script: card.is_script,
        deliver: card.deliver,
        chars: card.chars,
        preview: run.preview
      })
    },
    []
  )

  /** The body printed on the card: open THAT run, so the reader shows what you clicked. */
  const openRaw = useCallback(card => openRun(card, card.latest_id), [openRun])

  /**
   * History: a LIST of this job's runs, not a jump to one of them.
   *
   * The earlier version opened the newest reported run, which made the button
   * indistinguishable from clicking the body - reported as "history just shows
   * the current output". History has to be a chooser or it has no reason to
   * exist.
   */
  const openHistory = useCallback(card => {
    setHistory({ profile: card.profile, job_id: card.job_id, job_name: card.job_name })
  }, [])

  if (open) {
    return jsx(Reader, {
      item: open,
      t,
      // Returns to the history list when that is where this run was chosen
      // from, so drilling in and back out does not drop the whole list.
      onBack: () => setOpen(null),
      onRead: (item, read) => {
        void ctxRest(`/items/${encodeURIComponent(item.id)}/read`, {
          method: 'POST',
          body: { read }
        }).then(refresh, () => refresh())
      },
      onMute: (item, muted) => {
        void ctxRest(`/items/${encodeURIComponent(item.id)}/mute`, {
          method: 'POST',
          body: { muted }
        }).then(() => setOpen(null), refresh)
      }
    })
  }
  if (history) {
    return jsx(HistoryPanel, {
      job: history,
      t,
      onOpen: run =>
        openRun(
          // Build a card-shaped object so openRun can name the run.
          {
            job_name: history.job_name,
            profile: history.profile,
            recent: [run],
            latest_id: run.id,
            muted: false,
            schedule: run.schedule,
            is_script: run.is_script,
            deliver: run.deliver,
            chars: run.chars
          },
          run.id
        ),
      onBack: () => setHistory(null)
    })
  }


  return jsxs('div', {
    className: 'flex h-full min-h-0 flex-col',
    children: [
      // ---- header ----------------------------------------------------------
      jsxs('div', {
        className: 'flex shrink-0 flex-wrap items-center gap-2 px-3 pb-1 pt-2',
        children: [
          jsx('span', { className: 'text-sm font-medium', children: t('title') }),
          unread > 0 ? jsx(Badge, { variant: 'solid', size: 'xs', children: unread }) : null,
          errors > 0
            ? jsx(Badge, { variant: 'destructive', size: 'xs', children: errors })
            : null,
          jsx('span', {
            className: 'text-[0.6875rem] text-(--ui-text-tertiary)',
            children: t('subtitle', cards.length)
          }),
          jsx('span', { className: 'flex-1' }),
          // The Scheduled jobs page is a sidebar row only in ADVANCED mode
          // (`tier: 'advanced'` in the sidebar's SIDEBAR_NAV), so in simple mode
          // there is no way to reach it at all. The route itself is not gated -
          // `cronOpen = currentView === 'cron'` - so navigating here works in
          // every mode. This is the door simple mode is missing.
          jsxs(Button, {
            variant: 'ghost',
            size: 'sm',
            onClick: () => host.navigate(CRON_PATH),
            title: t('openScheduled'),
            className: 'gap-1',
            children: [jsx(Codicon, { name: 'watch', size: '0.75rem' }), t('scheduledJobs')]
          }),
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
          jsx('span', { className: 'min-w-0 flex-1' }),
          jsx(SearchField, {
            placeholder: t('search'),
            value: search,
            onChange: setSearch,
            containerClassName: 'w-56'
          })
        ]
      }),
      jsx('div', { className: 'min-h-0 flex-1', children: renderFeed() })
    ]
  })

  function renderFeed() {
    if (feed.isLoading && !feed.data) {
      return jsx('div', {
        className: 'flex flex-col gap-2 px-3',
        children: [0, 1, 2].map(i =>
          jsx(Skeleton, { key: i, className: 'h-28 w-full rounded-lg' })
        )
      })
    }
    if (feed.isError) {
      const raw = String(feed.error?.message || feed.error || '')
      // A 404 here is almost always a STALE ROUTE, not an empty inbox: the plugin
      // host caches each plugin's FastAPI app by file path and never invalidates
      // it, so a newly added endpoint does not exist until the gateway restarts.
      // Saying that out loud beats showing an empty page that reads as "no data".
      const stale = /\b404\b/.test(raw)
      return jsx('div', {
        className: 'grid h-full place-items-center px-6',
        children: jsx(ErrorState, {
          title: stale ? t('staleHost') : t('failed'),
          description: `${stale ? t('staleHint') : t('failedHint')}\n${raw}`
        })
      })
    }
    if (!cards.length) {
      // Distinguish "nothing to read" from "the page got no payload at all": an
      // undefined `cards` means the response shape was not what this page expects,
      // which is a deployment problem, not an empty inbox.
      const payloadMissing = feed.data !== undefined && !Array.isArray(feed.data?.cards)
      return jsx(EmptyState, {
        title: payloadMissing ? t('failed') : t('empty'),
        description: payloadMissing
          ? t('failedHint')
          : deferred || filter !== 'all'
            ? t('noMatch')
            : t('emptyHint')
      })
    }
    return jsx(ScrollArea, {
      className: 'h-full',
      children: jsx('div', {
        // A single column: the cards carry real text now, and two columns of
        // prose is harder to read than one. Density comes from the cards being
        // short, not from being narrow.
        className: 'flex flex-col gap-2 px-3 pb-8',
        children: cards.map(card =>
          jsx(JobCard, {
            key: `${card.profile}|${card.job_id}`,
            card,
            t,
            onOpenHistory: openHistory,
            onMarkJobRead: markJobRead,
            onMute: markMuted,
            onRaw: () => openRaw(card),
            onPickRun: openRun
          })
        )
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
// New-report notifications
// ---------------------------------------------------------------------------
//
// Runs from `register()`, NOT from a rendered component. That distinction is the
// whole design and it was learned the hard way:
//
//   A React mount point is a lie about liveness. This plugin's first notifier
//   lived inside the statusbar contribution, which is the only surface present
//   on every VIEW - but simple mode rests the statusbar hidden
//   (interface-mode.ts: statusbarVisible = freeTierSignInOpen ||
//   onboardingOpen), so in simple mode the component never mounted and no
//   notification ever fired. Worse, it failed silently: the Inbox page itself
//   still worked, so the plugin looked healthy.
//
// `register()` runs whenever the plugin is enabled, regardless of what is on
// screen. The watcher therefore uses only context primitives - ctx.rest,
// ctx.os.notify, ctx.onEvent, ctx.setInterval - all of which are torn down with
// the plugin. No component, no reliance on any visible chrome.
//
// `ctx.os.notify` is Electron's Notification in the desktop app and the browser
// Notification API in the Webapp (lib/browser-notifications.ts is its other
// half). Two host rules apply and are not the plugin's to change:
//   - it is suppressed while the window is focused (isBackgrounded()), so the
//     in-app toast via host.notify covers the foreground case;
//   - the Webapp half needs a secure context (https or localhost).
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
    return Array.isArray(raw) ? raw.filter(id => typeof id === 'string') : []
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
    /* storage is best-effort; never break the watcher over it */
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

/**
 * Start the headless watcher. Returns nothing; every timer, listener and
 * notification is registered against `ctx`, so unloading or disabling the
 * plugin stops all of it.
 */
function startNotifier(ctx) {
  // Seeded from the FIRST successful poll rather than from empty: whatever is
  // already unread when the app opens is not news, and announcing a backlog of
  // 50+ on every launch is the fastest way to get notifications switched off.
  let primed = false
  const seen = new Set()

  const tick = async () => {
    let items
    try {
      const res = await ctx.rest('/items?unread_only=true&limit=200')
      items = res?.items
    } catch {
      return // transient: a gateway restart must not kill the watcher
    }

    if (!Array.isArray(items)) return

    // The chip and the list both hide silent and muted runs; the notifier must
    // agree or it would announce things the page refuses to show.
    const unread = items.filter(item => !item.silent && !item.muted)

    if (!primed) {
      for (const item of unread) seen.add(item.id)
      const stored = loadNotifiedIds()
      // Carry the persisted set forward so a restart does not replay.
      for (const id of stored) seen.add(id)
      saveNotifiedIds([...seen])
      primed = true
      return
    }

    const fresh = unread.filter(item => !seen.has(item.id))

    if (!fresh.length) {
      // Reading items removes them from the unread list; drop them from the set
      // too so it tracks reality instead of growing forever.
      const live = new Set(unread.map(item => item.id))
      let shrunk = false
      for (const id of [...seen]) {
        if (!live.has(id)) {
          seen.delete(id)
          shrunk = true
        }
      }
      if (shrunk) saveNotifiedIds([...seen])
      return
    }

    for (const item of fresh) seen.add(item.id)
    saveNotifiedIds([...seen])

    const title = fresh.length === 1 ? 'New cron report' : `${fresh.length} new cron reports`
    const body = summarise(fresh)

    // Two doors. The OS door is gated on being away; the toast has no focus
    // gate. Calling both is core's own recommended split, and it is not
    // double-notification - whichever door is shut is the one that would have
    // been noise.
    ctx.os.notify({ title, body, activate: { path: PATH } })

    host.notify({
      kind: fresh.some(item => item.error) ? 'warning' : 'info',
      title,
      message: body,
      action: { label: 'Open Inbox', run: () => host.navigate(PATH) }
    })
  }

  // Backstop poll. `cron.changed` drives the immediate tick; this only covers a
  // missed event.
  ctx.setInterval(() => void tick(), DEFAULT_POLL_MS)
  ctx.onEvent(CHANGED_EVENT, () => void tick())

  // First tick is deferred so `register()` stays cheap and a slow backend never
  // delays the plugin's own registration.
  ctx.setTimeout(() => void tick(), 1500)
}

/**
 * The statusbar contribution. Purely a readout - the notifier deliberately does
 * NOT live here (see startNotifier): simple mode rests the statusbar hidden, so
 * anything mounted inside it stops running and fails silently.
 */
function StatusbarSlot() {
  return jsx('span', {
    className: 'inline-flex h-full items-center',
    children: jsx(UnreadChip, {})
  })
}

export default {
  id: ID,
  name: 'hermes-cron-inbox',
  register(ctx) {
    ctxRest = (path, opts) => ctx.rest(path, opts)

    // Headless: starts here, not in a component, so it runs in every UI mode.
    startNotifier(ctx)

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
