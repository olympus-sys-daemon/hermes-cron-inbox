# hermes-cron-inbox

An inbox for the cron reports Hermes already writes.

Hermes writes every scheduled run to `cron/output/<job_id>/<timestamp>.md` — including jobs
that deliver to Discord, Telegram or email. The Inbox is a **view** over those files: install
it and every watcher you already have shows up. No delivery changes, no webhooks, no per-job
configuration, and no second copy of your data to drift.

## What it adds

| Surface | Result |
|---|---|
| Sidebar row | **Cron Inbox** — appears after the desktop half is switched on (see Install) |
| Page `/inbox` | dashboard of jobs, each showing its latest report in full |
| Status bar chip | unread count, turns destructive on unread failures |
| ⌘K command | "Open Cron Inbox" |
| OS notification | one per batch of newly-arrived reports |

### The page is a dashboard, not a log

The first version listed runs: one row per document, a two-line preview, the actual report behind a
click. That made the reader do the work — to learn what a watcher currently says you had to open a
row, remember it, go back, open the next.

Now it is **one card per job**, and each card carries its newest reported run as text. Reading the
page *is* reading the reports. A click is only needed for run history or the untruncated tail of a
long report.

What a card shows:

- the job name, its schedule, and how many runs it has
- **the report itself**, monospace and line-preserved, clamped at ~14 lines with "Show full report"
  when there is more (bodies run from a few hundred bytes to ~250 KB)
- `N unread` / `N failed` only when non-zero, so a healthy job's footer stays quiet
- actions (mark read, history, mute) that appear on hover rather than at rest

Cards are ordered by **attention, not time**: errors first, then unread, then the rest, newest within
each group. Filters are All / Unread / Errors, plus search. The Reported / Everything switch is gone —
silent runs are hidden always, since a feed of nothing is a feed nobody reads. The API keeps an
`include_silent` flag for the scope.

Plus read/unread state, per-run mute, and search.

### OS notifications

When a report arrives that you have not read, the plugin raises a native notification — the OS
notification centre in the desktop app, the browser's Notification API in the Webapp. Clicking it
opens the Inbox.

Behaviour worth knowing:

- **The existing backlog never announces.** The first poll seeds the seen-set, so opening the app
  with 50 unread reports does not fire 50 notifications. Only reports that *arrive* while it is
  running are announced.
- **It tracks item ids, not a count.** A count can stay flat while one report arrives and another
  is read; diffing counts would miss the new one. Ids are `profile|job|stamp`, so the seen-set is
  stable across restarts (persisted in plugin storage, capped at 500).
- **Silent and muted runs never announce** — that would defeat the point of the filter.
- **One notification per batch**, not per item: "3 new cron reports / <job> and 2 more".

### It runs in every UI mode

The watcher starts from the plugin's `register()` — **not** from a rendered component. That is not a
style choice. This plugin's first notifier lived inside the statusbar contribution, which is the only
surface mounted on every *view*; but **simple mode rests the statusbar hidden**
(`interface-mode.ts`: `statusbarVisible = freeTierSignInOpen || onboardingOpen`), so in simple mode the
component never mounted, no notification ever fired, and nothing reported an error — the Inbox page
itself still worked, so the plugin looked healthy.

`register()` runs whenever the plugin is enabled, whatever is on screen. The watcher uses only
`ctx.rest` / `ctx.os.notify` / `ctx.onEvent` / `ctx.setInterval`, all torn down with the plugin. No
component, no dependence on any visible chrome — so simple mode, advanced mode, a hidden statusbar and
a collapsed window all behave the same.

The statusbar chip is now a pure readout and contributes nothing to liveness.

### It also fires while you are looking

`ctx.os.notify` is gated on being away from Hermes — the host drops it while the window is focused,
because a system alert is redundant next to an app you are already reading. That gate is not
configurable and a plugin cannot bypass it.

So the same event raises **both** doors:

| You are | You get |
|---|---|
| Looking at Hermes | an in-app toast, with an **Open Inbox** button |
| Away / minimised | an OS notification, click to open the Inbox |

This is core's own recommended split (`os.notify` for away, `host.notify` for foreground), and it is
not double-notification: whichever door is shut is the one that would have been noise. The toast
turns **warning** rather than neutral when the arriving report is an error.

One thing to know: the toast is visible but transient (it auto-dismisses), so if you are looking at
a different part of the app it can still pass you by. The statusbar chip is the durable count.

Two things must both be true for it to work:

1. **Settings → Notifications → "Plugin notifications"** must be on. It is on by default.
2. **The Webapp needs a secure context** — `https://` or `localhost`. On a plain `http://` LAN
   address browsers refuse to raise notifications (`isSecureContext` is false), so nothing shows
   and there is no error to see. The desktop app has no such constraint.

## Why it exists

Discord and email are fine transports and poor reading surfaces: a long structured report gets
truncated, a watcher that fires every 30 minutes mostly has nothing to say, and nothing is
searchable afterwards. The desktop app's own Cron page is job-centric — you expand a job to find
its history one run at a time.

The Inbox is chronological, cross-job, cross-profile, and it hides the noise.

### Hiding the noise is the whole trick

On a real install, ~78% of stored documents are silent runs:

```
241 documents on disk · 188 silent · 53 with something to report
```

A feed of "nothing happened" is a feed nobody opens. So a run is silently hidden when it
reported nothing, and the Everything scope brings it back on demand.

## Install

```bash
hermes plugins install olympus-sys-daemon/hermes-cron-inbox
```

Then **two switches**, both required. This bites everyone once: after step 1 the plugin is
installed and enabled, the backend routes answer, and *the sidebar row still does not appear* —
because a package's desktop half ships deliberately off.

1. **Agent half** — `hermes plugins enable hermes-cron-inbox` (or add it to `plugins.enabled`).
   Without this the routes 404 and the page shows its "inbox unavailable" state.
2. **Desktop half** — open **Capabilities → Plugins**, find **Cron Inbox**, and switch it on
   (the row shows a Desktop/GUI half with a switch; Settings → Plugins works too, by package
   name). The page, sidebar row and status chip register only once this is on.

Why it defaults off: a unified package's desktop half is stamped with a `.hermes-package.json`
marker, and the loader reads that marker as `defaultEnabled: false` (`runtime-loader.ts`) — so
every package's UI half is opt-in, matching the agent half's `plugins.enabled` gate. Your
explicit toggle is stored per-app in `localStorage` and wins from then on.

Already ticked and still nothing? Then it is a load error, not the switch: the app shows a
"Plugin 'hermes-cron-inbox' failed to load" toast and the plugin goes red in Capabilities → Plugins.
⌘K → **Reload desktop plugins** re-reads the folder.

Enable the plugin in every profile you want represented — the plugin reads the cron output of
the profile it runs in, plus that profile's sibling directories.

## How it reads a run document

There are two document shapes and they are not interchangeable. Assuming one is the most common
way to build this wrong.

**Script runs** (`no_agent`) — a short header, a `---` rule, then raw stdout:

```markdown
# Cron Job: PortWatch VI watcher

**Job ID:** abc123
**Run Time:** 2026-11-25 13:59:19
**Mode:** no_agent (script)

---

PortWatch VI · 2026-11-25 11:59 UTC
Leader : Belobug · 77.4%
```

A silent script run gets a `**Status:** silent (empty output)` line in its header. A script run
**with output has no status line at all** — so "contains the word silent" is the wrong rule; the
right one is "has a silent status".

**Agent runs** — a length-framed archive. The whole prompt is embedded, then the response:

```markdown
**Prompt Characters:** 168571
## Prompt

[168 KB of prompt]

**Response Characters:** 35
## Response

curator: 9 edits (memory 8, user 1)
```

The prompt routinely outweighs the response by three orders of magnitude, so the file is never
rendered verbatim. Only the framed response becomes the inbox content. The frame is validated
against its declared length, which means a prompt (or a response) that happens to quote
`## Response` cannot forge a boundary — and a truncated write yields *no* body rather than
prompt noise.

| Header / body | Meaning | Shown |
|---|---|---|
| no `Status:` + body after `---` | real output | yes |
| `Status: silent (empty output)` | nothing happened | hidden |
| `Status: silent (wakeAgent=false)` | script gate stayed quiet | hidden |
| `Status: no_change` | monitor diff was empty | hidden |
| `Status: BLOCKED` / `script failed` | broke | yes, flagged |
| agent response `[CRON_FAILURE]` | broke | yes, flagged |
| agent response `[SILENT]` | nothing happened | hidden |

## Data and storage

The Inbox stores **only** read/mute state, keyed by `profile|job_id|timestamp`, in
`<HERMES_HOME>/plugin-data/hermes-cron-inbox/inbox.db`. Bodies are re-read from disk on demand and
memoised on `(mtime, size)`, so a 170 KB archive is parsed once, not on every render.

Cron keeps the newest 50 documents per job (`cron.output_retention`). This is an inbox, not an
archive: read-state for documents cron has pruned is dropped on the next scan.

## API

All routes mount under `/api/plugins/hermes-cron-inbox/`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | root path, profiles seen, cron homes found |
| `GET` | `/feed` | **dashboard shape** — one card per job with its latest body; `limit`, `include_silent`, `include_muted`, `errors_only`, `unread_only`, `q`, `body_limit` |
| `GET` | `/items` | log shape — one row per run, newest first; `limit`, `offset`, `unread_only`, `include_silent`, `include_muted`, `errors_only`, `profile`, `job_id`, `q` |
| `GET` | `/items/{id}` | one run with its full body and source path |
| `POST` | `/items/{id}/read` | `{read: bool}` |
| `POST` | `/items/{id}/mute` | `{muted: bool}` |
| `POST` | `/mark-all-read` | `{profile?, include_silent?}` |
| `GET` | `/summary` | counters for the chip |
| `GET` | `/jobs` | per-job aggregation (docs, unread, errors, silent) |
| `GET` | `/config` | this plugin's settings (the desktop half cannot call `ctx.get_config`) |

Item ids are `profile|job_id|YYYY-MM-DD_HH-MM-SS`; malformed ids and traversal attempts are
refused before any path is built.

## Settings

From the app's Settings → Plugins:

| Key | Default | Meaning |
|---|---|---|
| `include_silent_by_default` | `false` | open on the Everything scope |
| `poll_seconds` | `60` | backstop refresh; `cron.changed` drives live updates |

## Using it against a remote gateway

Yes, with one installation difference that is easy to trip over.

**The UI half runs on the machine the app window runs on. The data half runs on the gateway.**
These are different files, and on a remote backend they are installed separately:

| Half | Where it lives | What it talks to |
|---|---|---|
| `desktop/plugin.js` | the computer running the Desktop app | this machine's plugin folder |
| `dashboard/plugin_api.py` | the gateway machine | that machine's `cron/output/` |

`ctx.rest` is connection-scoped — every call carries the connection the window is pointed at — so
the page reads the **remote** gateway's cron documents, not the local ones. The plugin folder is
app-level, deliberately: the docs state it stays installed across "every profile, gateway, or
remote machine the window connects to".

The catch is installation. `hermes plugins install` runs on the gateway and puts the Python half
there; it cannot reach the client's `~/.hermes/plugins` over a filesystem, so the desktop half has
to be installed by the app:

1. Install the agent half on the gateway: `hermes plugins install owner/repo`, then enable it.
2. On the machine running Desktop, open **Capabilities → Plugins → Install from Git**, paste the
   same repo, and make sure the **Desktop** component is checked.

The plugin's row then shows its desktop half as *unavailable (remote backend)* until step 2 —
that is the normal, correct state, not a bug.

The **webapp** (browser, `hermes webapp`) is simpler: its backend *is* the gateway that serves the
tab, so one install covers both halves and the server copies the desktop half itself.

## Limitations

- **In-app only.** A page cannot notify you when the app is closed. The chip covers the
  "Hermes is open, something arrived" case; for "tell me when I am away" keep a delivery
  target (Discord, ntfy, …) and let the Inbox be where you read it.
- **Bodies live in cron's retention window**, not forever.
- **Read-only over cron.** Nothing here triggers, edits, pauses or deletes a job.
- Runs listed are the ones stored on the gateway the window is connected to. Switching
  connections switches the inbox with it.

## Development

```bash
# tests need a Python with fastapi + pydantic (the gateway's own venv)
python tests/test_parse.py     # document parser, incl. the live corpus
python tests/test_routes.py    # every route against a sandboxed fixture tree

hermes plugins validate .
hermes plugins doctor .
```

Both test files run as plain scripts *and* under pytest — `pytest` is optional on purpose, so
they work on a machine that has no test dependencies installed.

## Layout

```
plugin.yaml              manifest; kind: standalone
__init__.py              agent half (deliberately registers nothing)
dashboard/
  manifest.json          declares plugin_api.py as the route module
  plugin_api.py          scan, parse, routes, read state
desktop/plugin.js        the page, sidebar row, status chip, palette command
tests/                   parser + route tests
```

## License

MIT
