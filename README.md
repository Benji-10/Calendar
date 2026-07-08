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
- Pinch vertically to make the day more detailed (taller hours); pinch/spread
  horizontally to move between day -> week -> month
- Swipe left/right (one finger) to move forward/back a day/week/month
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
