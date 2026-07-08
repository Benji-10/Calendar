/* Recurrence expansion + the auto-scheduler.
   Occurrences are computed in the event's own timezone, converted to
   absolute time, then projected into the device timezone for display
   and for computing busy periods. */

import { wallToUtc, utcToWall, addDaysKey, dowOfKey, dateKey } from "./time.js";

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

  const busyByDay = {};
  for (const o of expandOccurrences(events, todayKey, endKey, displayTz)) {
    if (o.allDay) continue;
    (busyByDay[o.dispDate] ||= []).push([o.dispStart, Math.min(o.dispEnd, 1440)]);
  }

  const catById = {};
  for (const c of categories) catById[c.id] = c;
  const fallbackCat = categories[0];

  /* priority populates first, then earlier deadline, then age */
  const pending = tasks
    .filter((t) => !t.done)
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      const da = a.deadline || "9999-12-31";
      const db = b.deadline || "9999-12-31";
      if (da !== db) return da < db ? -1 : 1;
      return a.createdAt - b.createdAt;
    });

  const nowMin = now.getHours() * 60 + now.getMinutes();
  const placed = {};

  for (const t of pending) {
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
        const slot = { date: k, start: cursor, end: cursor + t.duration };
        placed[t.id] = slot;
        (busyByDay[k] ||= []).push([slot.start, slot.end]);
        break;
      }
    }
  }
  return placed;
}
