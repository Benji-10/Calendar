/* Shared date/time + timezone helpers.
   Model: events store a wall-clock date ('YYYY-MM-DD'), start/end minutes,
   and an IANA timezone. Absolute instants are derived, then re-projected
   into the device timezone for display — so a 16:00 London event renders
   at 00:00 the next day when the device is set to Hong Kong. */

export const pad = (n) => String(n).padStart(2, "0");
export const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
export const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

export const toAmPm = (m) => {
  m = ((m % 1440) + 1440) % 1440;
  let h = Math.floor(m / 60);
  const mm = m % 60;
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return mm === 0 ? `${h} ${ap}` : `${h}:${pad(mm)} ${ap}`;
};

export const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseKey = (k) => {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d);
};
export const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
export const startOfWeek = (d) => addDays(d, -d.getDay());
export const sameDay = (a, b) => dateKey(a) === dateKey(b);

/* key-string arithmetic done at UTC noon so DST can never shift the date */
const keyToNoonUtc = (k) => {
  const [y, m, d] = k.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 12);
};
export const addDaysKey = (k, n) => {
  const t = new Date(keyToNoonUtc(k));
  t.setUTCDate(t.getUTCDate() + n);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};
export const dowOfKey = (k) => new Date(keyToNoonUtc(k)).getUTCDay();
export const diffDaysKey = (a, b) => Math.round((keyToNoonUtc(a) - keyToNoonUtc(b)) / 86400000);

/* ---- timezone conversion via Intl (no bundled tz database needed) ---- */
const dtfCache = {};
const getDtf = (tz) =>
  (dtfCache[tz] ||= new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }));

const wallParts = (utcMs, tz) => {
  const parts = getDtf(tz).formatToParts(new Date(utcMs));
  const m = {};
  for (const p of parts) m[p.type] = p.value;
  return m;
};

export function tzOffsetMs(tz, utcMs) {
  /* Intl gives whole seconds; snap the input to a second boundary so the
     offset is exact instead of carrying millisecond residue */
  const t = Math.floor(utcMs / 1000) * 1000;
  const p = wallParts(t, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - t;
}

/* wall clock (date + minutes) in tz -> absolute UTC ms (two-pass for DST) */
export function wallToUtc(dateStr, minutes, tz) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const naive = Date.UTC(y, m - 1, d, 0, minutes);
  let utc = naive - tzOffsetMs(tz, naive);
  utc = naive - tzOffsetMs(tz, utc);
  return utc;
}

/* absolute UTC ms -> wall clock in tz */
export function utcToWall(utcMs, tz) {
  const p = wallParts(utcMs, tz);
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: +p.hour * 60 + +p.minute };
}

export function timeZoneList() {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["UTC","Europe/London","Europe/Paris","America/New_York","America/Chicago","America/Denver","America/Los_Angeles","Asia/Hong_Kong","Asia/Tokyo","Asia/Singapore","Australia/Sydney"];
  }
}

/* short UTC-offset label for a zone at a given instant, e.g. "GMT+8" */
export function tzLabel(tz, utcMs = Date.now()) {
  const off = Math.round(tzOffsetMs(tz, utcMs) / 60000);
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return `GMT${sign}${Math.floor(a / 60)}${a % 60 ? ":" + pad(a % 60) : ""}`;
}
