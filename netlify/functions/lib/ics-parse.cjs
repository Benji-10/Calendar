/* Minimal ICS (RFC 5545) parser — enough for holiday feeds, birthday
   calendars, and typical published calendars: all-day events (VALUE=DATE),
   timed events (UTC "Z" or floating local), multi-day DTEND (exclusive),
   and FREQ=YEARLY recurrence (birthdays). Anything fancier is ignored
   rather than misinterpreted. */

const pad = (n) => String(n).padStart(2, "0");

function unfold(text) {
  const raw = text.replace(/\r/g, "").split("\n");
  const out = [];
  for (const line of raw) {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out;
}

function parseStamp(val, params) {
  /* returns { date:'YYYY-MM-DD', minutes|null } in device-local terms */
  const isDate = /VALUE=DATE(?!-)/.test(params) || /^\d{8}$/.test(val);
  if (isDate) {
    return { date: `${val.slice(0, 4)}-${val.slice(4, 6)}-${val.slice(6, 8)}`, minutes: null };
  }
  const m = val.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, se, z] = m;
  if (z) {
    const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(se || 0)));
    return { date: `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`, minutes: dt.getHours() * 60 + dt.getMinutes() };
  }
  /* floating or TZID: treat as wall time (right for the common cases) */
  return { date: `${y}-${mo}-${d}`, minutes: +h * 60 + +mi };
}

const addDaysStr = (k, n) => {
  const d = new Date(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10) + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function parseICS(text) {
  const lines = unfold(text);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { cur = {}; continue; }
    if (line === "END:VEVENT") {
      if (cur && cur.DTSTART && cur.SUMMARY) events.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i);
    const val = line.slice(i + 1);
    const name = key.split(";")[0];
    if (["DTSTART", "DTEND", "SUMMARY", "UID", "RRULE"].includes(name)) {
      cur[name] = { val, params: key };
    }
  }

  const out = [];
  for (const e of events) {
    const start = parseStamp(e.DTSTART.val, e.DTSTART.params);
    if (!start) continue;
    const title = e.SUMMARY.val.replace(/\\([,;nN])/g, (_, c) => (c === "," ? "," : c === ";" ? ";" : "\n")).trim();
    const allDay = start.minutes === null;
    const yearly = !!(e.RRULE && /FREQ=YEARLY/.test(e.RRULE.val));
    let endDate = null;
    let endMin = null;
    if (e.DTEND) {
      const end = parseStamp(e.DTEND.val, e.DTEND.params);
      if (end) {
        if (allDay) {
          /* DTEND is exclusive for all-day events */
          const incl = addDaysStr(end.date, -1);
          if (incl > start.date) endDate = incl;
        } else {
          endMin = end.minutes;
          if (end.date > start.date) endMin = Math.min(1440, (endMin ?? 0) + 1440); /* clamp overnight to same-day end */
        }
      }
    }
    out.push({
      uid: e.UID ? e.UID.val : `${start.date}_${title}`,
      title,
      allDay,
      date: start.date,
      endDate,
      start: allDay ? 0 : start.minutes,
      end: allDay ? 1440 : Math.max((endMin ?? start.minutes + 60), start.minutes + 15),
      yearly,
      month: +start.date.slice(5, 7),
      day: +start.date.slice(8, 10),
    });
  }
  return out;
}

module.exports = { parseICS };
