/* Recurrence expansion + the auto-scheduler.
   Occurrences are computed in the event's own timezone, converted to
   absolute time, then projected into the device timezone for display
   and for computing busy periods. */

import { wallToUtc, utcToWall, addDaysKey, dowOfKey, dateKey, diffDaysKey } from "./time.js";

/* A task's effective priority rises as its deadline nears:
   <=1 day -> High, <=3 days -> at least Medium. Returns 1..3. */
export function effectivePriority(task, todayKey) {
  let p = task.priority || 3;
  if (task.deadline) {
    const d = diffDaysKey(task.deadline, todayKey);
    if (d <= 1) p = 1;
    else if (d <= 3) p = Math.min(p, 2);
  }
  return p;
}

function matchesRule(ev, k) {
  if (k === ev.date) return true;
  const rep = ev.repeat || "none";
  if (rep === "none" || k < ev.date) return false;
  if (ev.repeatUntil && k > ev.repeatUntil) return false;
  const dow = dowOfKey(k);
  const baseDow = dowOfKey(ev.date);
  const dom = +k.slice(8, 10);
  const baseDom = +ev.date.slice(8, 10);
  switch (rep) {
    case "daily": return true;
    case "weekdays": return dow >= 1 && dow <= 5;
    case "weekly": return dow === baseDow;
    case "monthly": return dom === baseDom;
    case "yearly": return k.slice(5) === ev.date.slice(5);
    default: return false;
  }
}

/* All occurrences whose *display* date (device tz) falls in [startKey, endKey].
   All-day occurrences stay pinned to their wall date, like Apple Calendar. */
export function expandOccurrences(events, startKey, endKey, displayTz) {
  const out = [];
  const scanStart = addDaysKey(startKey, -2);
  const scanEnd = addDaysKey(endKey, 2);
  for (const ev of events) {
    if (ev.date > scanEnd) continue;
    const repeating = ev.repeat && ev.repeat !== "none";
    const from = ev.date > scanStart ? ev.date : scanStart;
    const to = repeating ? (ev.repeatUntil && ev.repeatUntil < scanEnd ? ev.repeatUntil : scanEnd) : ev.date;
    for (let k = from; k <= to; k = addDaysKey(k, 1)) {
      if (!matchesRule(ev, k)) continue;
      if (ev.exceptions && ev.exceptions.includes(k)) continue;
      if (ev.allDay) {
        if (k >= startKey && k <= endKey) out.push({ ev, occDate: k, allDay: true, dispDate: k, renderKey: ev.id + "_" + k });
        continue;
      }
      const startUtc = wallToUtc(k, ev.start, ev.tz);
      const durMin = ev.end - ev.start;
      const endUtc = startUtc + durMin * 60000;
      const w = utcToWall(startUtc, displayTz);
      if (w.date < startKey || w.date > endKey) continue;
      out.push({
        ev, occDate: k, allDay: false, renderKey: ev.id + "_" + k,
        dispDate: w.date, dispStart: w.minutes, dispEnd: w.minutes + durMin,
        startUtc, endUtc,
      });
    }
  }
  return out;
}

/* Scheduling window for a category on a given date:
   a dated override (holiday / adjusted hours) beats the weekly pattern. */
export function windowFor(cat, key) {
  if (cat.overrides && Object.prototype.hasOwnProperty.call(cat.overrides, key)) return cat.overrides[key];
  return cat.hours[dowOfKey(key)] || null;
}

export function scheduleTasks(tasks, events, categories, now, displayTz) {
  const HORIZON = 28;
  const gran = 15;
  const snapUp = (m) => Math.ceil(m / gran) * gran;
  const todayKey = dateKey(now);
  const endKey = addDaysKey(todayKey, HORIZON);
  const nowMin = now.getHours() * 60 + now.getMinutes();

  const busyByDay = {};
  for (const o of expandOccurrences(events, todayKey, endKey, displayTz)) {
    if (o.allDay) continue;
    (busyByDay[o.dispDate] ||= []).push([o.dispStart, Math.min(o.dispEnd, 1440)]);
  }

  const catById = {};
  for (const c of categories) catById[c.id] = c;
  const fallbackCat = categories[0];
  const placed = {};

  /* Pass 1 — tasks with a user-chosen time stay put while the slot is
     still ahead, or forever if auto-reschedule is off. Only a missed
     slot with auto-reschedule on falls through to the auto pass. */
  const autoQueue = [];
  for (const t of tasks.filter((x) => !x.done)) {
    const s = t.scheduledAt;
    if (s) {
      const end = s.start + t.duration;
      const stillAhead = s.date > todayKey || (s.date === todayKey && end > nowMin);
      if (stillAhead || t.autoReschedule === false) {
        placed[t.id] = { date: s.date, start: s.start, end, pinned: true };
        if (s.date >= todayKey && s.date <= endKey) (busyByDay[s.date] ||= []).push([s.start, Math.min(end, 1440)]);
        continue;
      }
    }
    autoQueue.push(t);
  }

  /* Pass 2 — priority populates first, then earlier deadline, then age */
  autoQueue.sort((a, b) => {
    const pa = effectivePriority(a, todayKey), pb = effectivePriority(b, todayKey);
    if (pa !== pb) return pa - pb;
    const da = a.deadline || "9999-12-31";
    const db = b.deadline || "9999-12-31";
    if (da !== db) return da < db ? -1 : 1;
    return a.createdAt - b.createdAt;
  });

  for (const t of autoQueue) {
    const cat = catById[t.category] || fallbackCat;
    if (!cat) continue;
    for (let i = 0; i < HORIZON; i++) {
      const k = addDaysKey(todayKey, i);
      const win = windowFor(cat, k);
      if (!win) continue;
      let winStart = win.start;
      const winEnd = win.end;
      if (i === 0) winStart = Math.max(winStart, snapUp(nowMin));
      if (winStart >= winEnd) continue;

      const busy = (busyByDay[k] || []).slice().sort((a, b) => a[0] - b[0]);
      let cursor = winStart;
      let fits = false;
      for (const [s, e] of busy) {
        if (Math.min(s, winEnd) - cursor >= t.duration) { fits = true; break; }
        cursor = snapUp(Math.max(cursor, e));
        if (cursor >= winEnd) break;
      }
      if (!fits && cursor < winEnd && winEnd - cursor >= t.duration) fits = true;
      if (fits) {
        const slot = { date: k, start: cursor, end: cursor + t.duration, pinned: false };
        placed[t.id] = slot;
        (busyByDay[k] ||= []).push([slot.start, slot.end]);
        break;
      }
    }
  }
  return placed;
}

/* ---- overlap layout ----
   Given items with {start,end} on one day, assign each a column index and a
   column count for its overlap cluster. Narrow (side-by-side) only when text
   would actually collide; otherwise items get a small left indent so their
   colored borders don't stack, but bodies still use most of the width.
   Later items sit on top (higher z) so both stay clickable. */
export function layoutDay(items, clearanceMin = 30) {
  const sorted = items.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const clusters = [];
  let cur = [];
  let curEnd = -1;
  for (const it of sorted) {
    if (cur.length && it.start >= curEnd) { clusters.push(cur); cur = []; curEnd = -1; }
    cur.push(it);
    curEnd = Math.max(curEnd, it.end);
  }
  if (cur.length) clusters.push(cur);

  const out = [];
  for (const cluster of clusters) {
    /* greedy column packing within the cluster */
    const cols = [];
    for (const it of cluster) {
      let placed = false;
      for (let ci = 0; ci < cols.length; ci++) {
        if (cols[ci] <= it.start) { it._col = ci; cols[ci] = it.end; placed = true; break; }
      }
      if (!placed) { it._col = cols.length; cols.push(it.end); }
    }
    const nCols = cols.length;
    /* Text clashes when two time-overlapping items in different columns
       start within a title-height of each other — then give every item an
       equal share of the width. Otherwise the starts are staggered enough
       that titles don't collide, so just indent the later ones. */
    let tight = nCols >= 3;
    if (!tight && nCols === 2) {
      for (let i = 0; i < cluster.length && !tight; i++) {
        for (let j = i + 1; j < cluster.length && !tight; j++) {
          const a = cluster[i], b = cluster[j];
          const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
          if (a._col !== b._col && overlap > 0 && Math.abs(a.start - b.start) < clearanceMin) tight = true;
        }
      }
    }
    for (let i = 0; i < cluster.length; i++) {
      const it = cluster[i];
      out.push({
        item: it,
        col: it._col,
        cols: nCols,
        mode: nCols <= 1 ? "full" : tight ? "split" : "indent",
        z: 2 + i,
      });
    }
  }
  return out;
}
