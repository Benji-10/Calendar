/* Holiday calendars via Nager.Date (free, no key, public-domain data).
   We fetch per country+year on demand and cache in the data blob so it
   works offline afterwards and counts toward the user's synced state. */

export const HOLIDAY_CALENDARS = [
  { code: "US", name: "United States", tz: "America/New_York", color: "red" },
  { code: "GB", name: "United Kingdom", tz: "Europe/London", color: "blue" },
  { code: "JP", name: "Japan", tz: "Asia/Tokyo", color: "red" },
  { code: "CN", name: "China", tz: "Asia/Shanghai", color: "red" },
  { code: "KR", name: "South Korea", tz: "Asia/Seoul", color: "blue" },
  { code: "HK", name: "Hong Kong", tz: "Asia/Hong_Kong", color: "red" },
  { code: "TW", name: "Taiwan", tz: "Asia/Taipei", color: "red" },
  { code: "SG", name: "Singapore", tz: "Asia/Singapore", color: "red" },
  { code: "AU", name: "Australia", tz: "Australia/Sydney", color: "green" },
  { code: "CA", name: "Canada", tz: "America/Toronto", color: "red" },
  { code: "DE", name: "Germany", tz: "Europe/Berlin", color: "orange" },
  { code: "FR", name: "France", tz: "Europe/Paris", color: "blue" },
  { code: "IN", name: "India", tz: "Asia/Kolkata", color: "orange" },
  { code: "IT", name: "Italy", tz: "Europe/Rome", color: "green" },
  { code: "ES", name: "Spain", tz: "Europe/Madrid", color: "orange" },
  { code: "MX", name: "Mexico", tz: "America/Mexico_City", color: "green" },
  { code: "BR", name: "Brazil", tz: "America/Sao_Paulo", color: "green" },
  { code: "NL", name: "Netherlands", tz: "Europe/Amsterdam", color: "orange" },
];

export const calByCode = (code) => HOLIDAY_CALENDARS.find((c) => c.code === code);

/* Guess the user's country from the device timezone, so we can default
   both the holiday calendar and the new-event timezone sensibly. */
export function guessCountry() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const hit = HOLIDAY_CALENDARS.find((c) => c.tz === tz);
  if (hit) return hit.code;
  const region = tz.split("/")[0];
  const byRegion = { Europe: "GB", America: "US", Asia: "JP", Australia: "AU" };
  return byRegion[region] || "US";
}

export async function fetchHolidays(code, year) {
  const r = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/${code}`);
  if (!r.ok) throw new Error(`holiday fetch failed (${r.status})`);
  const rows = await r.json();
  return rows.map((h) => ({ date: h.date, name: h.localName, en: h.name }));
}

/* Which years we need to have cached to cover a visible range (plus a
   little padding), so month-scrolling near a year boundary stays populated. */
export function yearsForRange(startKey, endKey) {
  const y0 = +startKey.slice(0, 4) - 1;
  const y1 = +endKey.slice(0, 4) + 1;
  const out = [];
  for (let y = y0; y <= y1; y++) out.push(y);
  return out;
}
