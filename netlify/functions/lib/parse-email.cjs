/* Parse a booking/confirmation email into suggested calendar events.
   Primary path: schema.org JSON-LD embedded in HTML emails — the same
   structured data Gmail uses for its automatic events (airlines, hotels,
   restaurants, ticketing all embed it). Fallback: date/time heuristics on
   the plain text with the subject as the title. CommonJS so the Netlify
   function can require() it; tests import it the same way. */

const pad = (n) => String(n).padStart(2, "0");

/* "2026-07-12T14:30:00+01:00" | "2026-07-12" -> {date, minutes|null}
   The clock time is taken as written (the venue's wall time), which is what
   a person wants on their calendar for flights and check-ins. */
function parseIsoStamp(v) {
  if (!v || typeof v !== "string") return null;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!m) return null;
  return { date: `${m[1]}-${m[2]}-${m[3]}`, minutes: m[4] ? +m[4] * 60 + +m[5] : null };
}

function cleanSubject(s) {
  return (s || "").replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, "").trim().slice(0, 120);
}

/* ---------- JSON-LD ---------- */

function extractJsonLd(html) {
  if (!html) return [];
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const nodes = Array.isArray(parsed) ? parsed : parsed["@graph"] ? parsed["@graph"] : [parsed];
      out.push(...nodes);
    } catch { /* malformed block — skip */ }
  }
  return out;
}

const typeOf = (n) => {
  const t = n && n["@type"];
  return Array.isArray(t) ? t[0] : t || "";
};
const nameOf = (x) => (x && (x.name || x.iataCode)) || "";

function suggestionFromNode(node) {
  const t = typeOf(node);
  const r = node.reservationFor || node;

  if (t === "FlightReservation") {
    const dep = parseIsoStamp(r.departureTime);
    if (!dep) return null;
    const arr = parseIsoStamp(r.arrivalTime);
    const flight = `${nameOf(r.airline) || ""}${r.flightNumber || ""}`.trim();
    const route = [nameOf(r.departureAirport), nameOf(r.arrivalAirport)].filter(Boolean).join(" → ");
    const end = arr && arr.date === dep.date && arr.minutes != null ? arr.minutes : Math.min(1440, (dep.minutes ?? 540) + 120);
    return {
      kind: "flight",
      title: `Flight ${flight}${route ? ` ${route}` : ""}`.trim(),
      date: dep.date, endDate: null, allDay: dep.minutes == null,
      start: dep.minutes ?? 0, end: dep.minutes == null ? 1440 : Math.max(end, dep.minutes + 30),
      venue: nameOf(r.departureAirport),
      details: [r.reservationNumber || node.reservationNumber, arr && arr.date !== dep.date ? `arrives ${arr.date}` : null].filter(Boolean).join(" · "),
    };
  }

  if (t === "LodgingReservation") {
    const ci = parseIsoStamp(node.checkinTime || node.checkinDate);
    const co = parseIsoStamp(node.checkoutTime || node.checkoutDate);
    if (!ci) return null;
    return {
      kind: "hotel",
      title: `Hotel: ${nameOf(r) || "stay"}`,
      date: ci.date, endDate: co && co.date > ci.date ? co.date : null,
      allDay: true, start: 0, end: 1440,
      venue: (r.address && (r.address.streetAddress || r.address.addressLocality)) || nameOf(r),
      details: node.reservationNumber || "",
    };
  }

  if (t === "TrainReservation" || t === "BusReservation") {
    const dep = parseIsoStamp(r.departureTime);
    if (!dep) return null;
    const arr = parseIsoStamp(r.arrivalTime);
    const route = [nameOf(r.departureStation || r.departureBusStop), nameOf(r.arrivalStation || r.arrivalBusStop)].filter(Boolean).join(" → ");
    const end = arr && arr.date === dep.date && arr.minutes != null ? arr.minutes : Math.min(1440, (dep.minutes ?? 540) + 90);
    return {
      kind: "train",
      title: `${t === "BusReservation" ? "Bus" : "Train"}${route ? ` ${route}` : ""}`,
      date: dep.date, endDate: null, allDay: dep.minutes == null,
      start: dep.minutes ?? 0, end: dep.minutes == null ? 1440 : Math.max(end, dep.minutes + 15),
      venue: nameOf(r.departureStation || r.departureBusStop),
      details: node.reservationNumber || "",
    };
  }

  if (t === "FoodEstablishmentReservation") {
    const st = parseIsoStamp(node.startTime);
    if (!st) return null;
    return {
      kind: "dining",
      title: `Reservation: ${nameOf(r) || "table"}`,
      date: st.date, endDate: null, allDay: st.minutes == null,
      start: st.minutes ?? 0, end: st.minutes == null ? 1440 : Math.min(1440, st.minutes + 90),
      venue: nameOf(r),
      details: node.partySize ? `party of ${node.partySize}` : "",
    };
  }

  if (t === "EventReservation" || t === "Event") {
    const ev = t === "EventReservation" ? r : node;
    const st = parseIsoStamp(ev.startDate);
    if (!st) return null;
    const en = parseIsoStamp(ev.endDate);
    return {
      kind: "event",
      title: nameOf(ev) || "Event",
      date: st.date,
      endDate: st.minutes == null && en && en.date > st.date ? en.date : null,
      allDay: st.minutes == null,
      start: st.minutes ?? 0,
      end: st.minutes == null ? 1440 : en && en.date === st.date && en.minutes != null ? Math.max(en.minutes, st.minutes + 15) : Math.min(1440, st.minutes + 120),
      venue: (ev.location && nameOf(ev.location)) || "",
      details: "",
    };
  }

  return null;
}

/* ---------- heuristic fallback ---------- */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function findDate(text) {
  let m = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  /* "12 July 2026" / "12 Jul 2026" */
  m = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})\b/i);
  if (m) return `${m[3]}-${pad(MONTHS.indexOf(m[2].toLowerCase()) + 1)}-${pad(+m[1])}`;
  /* "July 12, 2026" */
  m = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i);
  if (m) return `${m[3]}-${pad(MONTHS.indexOf(m[1].toLowerCase()) + 1)}-${pad(+m[2])}`;
  /* 12/07/2026 — day-first (GB convention) unless first part can't be a day */
  m = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (m) {
    const a = +m[1], b = +m[2];
    const [day, mon] = a > 12 ? [a, b] : b > 12 ? [b, a] : [a, b];
    if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) return `${m[3]}-${pad(mon)}-${pad(day)}`;
  }
  return null;
}

function findTime(text) {
  let m = text.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)\b/i);
  if (m) {
    let h = +m[1] % 12;
    if (m[3].toLowerCase() === "pm") h += 12;
    return h * 60 + +m[2];
  }
  m = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (m) return +m[1] * 60 + +m[2];
  return null;
}

const KIND_WORDS = [
  ["flight", /\bflight|airline|boarding|departure\b/i],
  ["hotel", /\bhotel|check-?in|booking confirm|accommodation|stay\b/i],
  ["dining", /\breservation|table for\b/i],
  ["delivery", /\bdelivery|arriving|dispatched|out for\b/i],
  ["appointment", /\bappointment|consultation|dentist|doctor|gp\b/i],
];

function heuristicSuggestion(subject, text) {
  /* drop forwarded-header lines (From:/Date:/Sent:/...) so the email's own
     send-date can't masquerade as the event date */
  const cleaned = (text || "").split("\n").filter((l) => !/^\s*>?\s*(from|date|sent|to|cc|subject)\s*:/i.test(l)).join("\n");
  const hay = `${subject}\n${cleaned}`.slice(0, 6000);
  const date = findDate(hay);
  if (!date) return null;
  const time = findTime(hay);
  let kind = "email";
  for (const [k, re] of KIND_WORDS) if (re.test(hay)) { kind = k; break; }
  return {
    kind,
    title: cleanSubject(subject) || "From email",
    date, endDate: null,
    allDay: time == null,
    start: time ?? 0,
    end: time == null ? 1440 : Math.min(1440, time + 60),
    venue: "",
    details: "parsed from email text — check the details",
  };
}

/* ---------- entry ---------- */

function parseEmail({ subject, html, text }) {
  const out = [];
  const seen = new Set();
  for (const node of extractJsonLd(html)) {
    const s = suggestionFromNode(node);
    if (!s) continue;
    const key = `${s.title}_${s.date}_${s.start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  if (!out.length) {
    const h = heuristicSuggestion(subject, text || (html || "").replace(/<[^>]+>/g, " "));
    if (h) out.push(h);
  }
  return out.slice(0, 6);
}

module.exports = { parseEmail };
