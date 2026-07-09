# Rollover — auto-scheduling checklist + calendar

Tasks roll forward into your next free slot until you check them off.
Events are fixed; tasks flow around them inside per-category hours.

## Run locally
    npm install
    npm run dev

Note: sign-in only works against a deployed Netlify site. For local dev
against your live Identity instance, change `netlifyIdentity.init()` in
`src/storage.js` to `netlifyIdentity.init({ APIUrl: "https://YOUR-SITE.netlify.app/.netlify/identity" })`.
Signed-out mode (localStorage) works everywhere with no setup.

## Deploy to Netlify (Git-connected — required for accounts)
1. Push this folder to a GitHub repo
2. Netlify: Add new site -> Import from Git -> pick the repo
   (netlify.toml already configures the build and the serverless function)

## Enable accounts + Neon
1. Neon: create a free project at neon.tech, copy the connection string
   (postgresql://...@...neon.tech/neondb?sslmode=require)
2. Netlify: Site configuration -> Environment variables -> add
   DATABASE_URL = that connection string
3. Netlify: Site configuration -> Identity -> Enable Identity
   (set Registration to invite-only and invite yourself, unless you want open signup)
4. Redeploy. Sign in via the sidebar; the function auto-creates its one
   table (planner_data: user_id, data jsonb, updated_at) on first request.

Signed out, data stays in the browser's localStorage. On first sign-in,
existing local data is pushed up to your account automatically.

## Features
- Auto-scheduler: unchecked tasks reflow to the next open slot every 30s;
  High priority fills slots before Medium before Low
- Time categories: each task rolls over only within its category's hours
  (Work defaults to Mon-Fri 9:00-19:00); per-date exceptions for holidays
- Drag empty grid to create; drag blocks to move (tasks get pinned); pull edges to resize (long-press on mobile)
- All-day events pinned to the top row; repeat rules (daily/weekdays/weekly/monthly/yearly)
  with per-day delete; title autosuggest for events used 3+ times
- Location search (Photon/OSM, fast autocomplete) with open-in-Google-Maps links; picking a
  location suggests the event's timezone
- Timezone-aware: events store absolute time + their own zone and are shown
  in the device's local time
- Dark mode by default (toggle in the header); completed tasks stay on the
  calendar in green so the day's accomplishments remain visible
- Tasks can be given an explicit time ("Pick a time") with a per-task
  auto-reschedule switch: on = missed tasks roll forward, off = stay put

## Tests
    npm test
Runs a Vitest + Testing Library suite that mounts the app, adds a task,
switches views, and opens the editor — asserting no runtime errors.

## Zoom & gestures
- Pinch vertically to zoom the day (anchored at your fingers); pinch/spread
  horizontally to move between day -> week -> month
- Swipe or side-scroll (trackpad / shift+wheel) to roll the days along, snapping day-by-day; works in every view
- Desktop: Ctrl/Cmd + scroll wheel zooms the time axis
- Smooth cross-fade when switching views

## Holidays
Sidebar -> "Holiday calendars". Pick any of 18 countries; their public
holidays appear as all-day events (data from the free Nager.Date API,
cached in your synced data). Your country also sets the default suggestion
basis. Holiday events are read-only.

## Priorities & deadlines
High/Medium/Low control colour and scheduling order (High fills free slots
first). A task's priority automatically escalates as its deadline nears
(<=3 days -> at least Medium, <=1 day -> High), so urgent work rises to the
top of the queue on its own.

## Mobile
On screens under 640px the task list becomes a slide-out drawer (top-left
button, badge shows pending count) so the calendar gets the full width, and
week view shows a rolling 3-day window instead of 7 days.

## Mobile creation
Hold on empty grid to spawn a 1-hour event block under your finger, drag it
anywhere (hold at the left/right edge to roll onto other days/weeks), release
to open the editor pre-filled. An iOS-style week strip sits above the day
headers — tap a day to jump, swipe it to change weeks. Inputs are 16px on
mobile + maximum-scale=1 so iOS doesn't zoom the page when a field focuses.

## All-day events
All-day events take a start AND end date, so trips/conferences span several
days across the all-day row and the month grid. Timed hours are preserved
when you toggle all-day off again.

## Sync troubleshooting ("sync failed — tap for details")
The error label now tells you which of these it is:
1. 404 — functions aren't deployed. Netlify Drop only ships static files;
   accounts REQUIRE a Git-connected deploy (or `netlify deploy` via CLI).
2. 500 — DATABASE_URL missing. Netlify -> Site configuration ->
   Environment variables -> add DATABASE_URL = your Neon connection string
   (the pooler string from the Neon dashboard) -> trigger a redeploy.
3. 401 — Identity issue. Enable Identity in Site configuration, sign out/in.
NEVER commit the connection string to the repo — it stays in the env var.

## Task dependencies (processes)
A task can be set to come "After" another task (editor -> After row). The
scheduler places prerequisites first and never schedules a dependent before
its prerequisite's slot ends — so research-flight -> book-train -> book-hotel
rolls over as a chain, in order, no matter how the earlier steps slip. Done
prerequisites release the constraint; an unschedulable prerequisite shows the
dependent as "Waiting on ...". Cycles are prevented in the picker and broken
safely by the scheduler. Chained tasks show a link icon.

## Mobile gesture model
One finger scrolls. Hold spawns a draggable event block (release opens the
editor). Two fingers zoom — smooth, frame-synced, anchored at your fingers.
The week strip changes days/weeks; month view still swipes between months.

## Time off (holidays in the main UI)
＋ New -> "Time off": pick a start and end date, done. Those days show a 🏖
all-day banner, the whole day is shaded as downtime, and the auto-scheduler
skips them entirely — tasks roll to the other side of the break. This is the
day-to-day way to declare holidays; the per-category exceptions in Hours &
Categories remain for fine-tuning (e.g. only Work off, Personal still open).

## PWA / icons
icon.svg (favicon), icon-192/512.png + manifest.webmanifest (installable PWA,
standalone display), apple-touch-icon.png (iOS home screen). The app locks to
the dynamic viewport (100dvh) with safe-area padding, so no more page-level
scrollbar behind the calendar on iPhone.

## PWA & app icon
Rollover installs as a PWA (Add to Home Screen). Pick from four app icons in
the sidebar footer — the choice is applied to the manifest/apple-touch-icon
immediately, but installed home-screen icons are fixed at install time (a web
platform limit): re-add the app after changing it. No service worker is
included on purpose, so deploys are never served stale from a cache.

## Waiting list
Sidebar -> "Waiting on": track things you're waiting for from other people
(a reply, family plans). Link a task to a waiting item via "Waiting for" in
the task editor — the task stays off the calendar entirely (dependents too)
until you check the waiting item off. Each item shows which tasks it's
holding, so you know exactly what to chase people about.

## Progress dashboard
Chart button in the header: GitHub-style contribution heatmap of completed
tasks (20 weeks), totals (done / this week / streak / pending), events in
the last 30 days, and done-by-category / done-by-priority breakdowns.

## Notes & checklists
Every event and task takes free-text notes — URLs become tappable link chips
(recipe links etc.) — and a checklist (packing lists and the like). Checklist
progress (2/5) shows in the task list.

## Views & navigation (v2)
Three levels: week (3-day on mobile), month, year (analogue-style 12-month
overview). The header label is the navigation: tap "Jul 2026" in week view to
zoom out to the month, tap "2026" to reach the year; tap a month in year view
or a day in month view to drill back down. Pinch is now zoom-only and runs as
a pure compositor transform during the gesture (layout commits once on
release), so it tracks fingers at full frame rate.

## Sync safety & multi-device
- A device may only push to the server after a successful pull that session —
  a device that failed to load can never overwrite the server with its empty
  state (this class of data loss is what the rule exists for).
- Before remote data overwrites different local data, the local copy is
  snapshotted to a backup key. Sidebar -> "Recover older data on this device"
  merges that backup (by id) back in and re-syncs it.
- Signed-in devices re-pull every 60s and whenever the tab/app regains focus
  or comes back online, skipping pulls within 5s of a local push so devices
  never fight their own edits.

## Calendars (subscriptions + personal)
Sidebar -> Calendars: subscribe to any public .ics / webcal feed (fetched
through the ics Netlify function every 12h, cached per device) — e.g. an
official holidays feed if the built-in observed-date holidays don't match
your preference. Feed events are read-only, support all-day/multi-day/timed
entries and FREQ=YEARLY recurrence (birthday calendars). Personal calendars
group your own events (assign in the event editor) and toggle on/off.
Note: feed fetching needs the deployed Netlify function (not vite dev).

## Data-safety contract
Every server write that changes the blob first snapshots the previous
version into `planner_history` (newest 20 kept per user), so no bug or
migration can put data more than one restore away. Schema changes are
additive only — the client's migrate() fills defaults on read; any future
breaking change is done as query -> transform -> reinsert, never a
destructive rewrite. To inspect or roll back, from the app's console:

  const jwt = await netlifyIdentity.currentUser().jwt();
  // list versions:
  await (await fetch('/.netlify/functions/data?history=1', { headers: { Authorization: 'Bearer ' + jwt } })).json();
  // restore one:
  await fetch('/.netlify/functions/data', { method: 'PUT', headers: { Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json' }, body: JSON.stringify({ restore: ID }) });

Then reload; the periodic pull picks the restored blob up everywhere.
