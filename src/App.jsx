import React, { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback, useContext, createContext } from "react";
import tzlookup from "tz-lookup";
import {
  toAmPm, MONTHS, DOW, deviceTz,
  dateKey, parseKey, addDays, startOfWeek, sameDay,
  addDaysKey, dowOfKey, diffDaysKey,
  wallToUtc, utcToWall, timeZoneList, tzLabel,
} from "./time.js";
import { expandOccurrences, scheduleTasks, windowFor, layoutDay, effectivePriority } from "./scheduler.js";
import { parseICS } from "./ics.js";
import { initIdentity, openLogin, doLogout, loadData, saveData, fetchEmailInbox, actOnSuggestion, getAuthHeader, STORE_KEY } from "./storage.js";
import { HOLIDAY_CALENDARS, calByCode, guessCountry, holidayFeedUrl } from "./holidays.js";

const HOUR_H_BASE = 48;
const HOUR_H_MIN = 30;
const HOUR_H_MAX = 84;
const AXIS_W = 56;
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

/* ---------- inline SVG icons (no emoji) ---------- */
const ICONS = {
  sliders: <><line x1="4" y1="6" x2="20" y2="6" /><circle cx="9" cy="6" r="2.1" /><line x1="4" y1="12" x2="20" y2="12" /><circle cx="15" cy="12" r="2.1" /><line x1="4" y1="18" x2="20" y2="18" /><circle cx="8" cy="18" r="2.1" /></>,
  flag: <><path d="M5 21V4" /><path d="M5 4h12l-2.5 4L17 12H5" /></>,
  user: <><circle cx="12" cy="8" r="3.6" /><path d="M4.5 20c1-4 4.5-5.5 7.5-5.5s6.5 1.5 7.5 5.5" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><line x1="12" y1="2.5" x2="12" y2="5" /><line x1="12" y1="19" x2="12" y2="21.5" /><line x1="2.5" y1="12" x2="5" y2="12" /><line x1="19" y1="12" x2="21.5" y2="12" /><line x1="5.2" y1="5.2" x2="6.9" y2="6.9" /><line x1="17.1" y1="17.1" x2="18.8" y2="18.8" /><line x1="18.8" y1="5.2" x2="17.1" y2="6.9" /><line x1="5.2" y1="18.8" x2="6.9" y2="17.1" /></>,
  moon: <path d="M20.5 13.5A8.5 8.5 0 1 1 10.5 3.5a7 7 0 0 0 10 10z" />,
  mapPin: <><path d="M12 21c-3.5-3.4-6-6.7-6-9.8a6 6 0 1 1 12 0c0 3.1-2.5 6.4-6 9.8z" /><circle cx="12" cy="11" r="2.2" /></>,
  pushpin: <><path d="M9 4h6l-.6 5 2.6 3H7l2.6-3z" /><line x1="12" y1="12" x2="12" y2="19" /></>,
  link: <><path d="M9.5 14.5l5-5" /><path d="M11.2 7.2l1.6-1.6a3.7 3.7 0 0 1 5.6 5.6l-1.6 1.6" /><path d="M12.8 16.8l-1.6 1.6a3.7 3.7 0 0 1-5.6-5.6l1.6-1.6" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3.5 2" /></>,
  chart: <><line x1="5" y1="20" x2="5" y2="12" /><line x1="11" y1="20" x2="11" y2="5" /><line x1="17" y1="20" x2="17" y2="9" /><line x1="2.5" y1="20" x2="19.5" y2="20" /></>,
  menu: <><line x1="4" y1="6.5" x2="20" y2="6.5" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="17.5" x2="20" y2="17.5" /></>,
  umbrella: <><path d="M12 3a8.5 8.5 0 0 1 8.5 8.5H3.5A8.5 8.5 0 0 1 12 3z" /><path d="M12 11.5V18a2 2 0 0 0 4 0" /></>,
  chevL: <path d="M14.5 5.5L8 12l6.5 6.5" />,
  mail: <><rect x="3" y="5.5" width="18" height="13" rx="2.5" /><path d="M3.5 7l8.5 6 8.5-6" /></>,
  gear: <><circle cx="12" cy="12" r="3.2" /><path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.2 5.2l1.9 1.9M16.9 16.9l1.9 1.9M18.8 5.2l-1.9 1.9M7.1 16.9l-1.9 1.9" /></>,
};
function Icon({ name, size = 16, color = "currentColor", sw = 1.8, style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={sw}
      strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, ...style }} aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

/* map sync failures to what the person can actually do about them */
function explainSyncError(err) {
  const m = String(err?.message || err);
  if (m.includes("404")) return "Sync endpoint not found (404). Serverless functions aren't deployed — Netlify Drop only ships static files, so use a Git-connected deploy (or `netlify deploy`) for accounts to work.";
  if (m.includes("500")) return "Server error (500). Most likely DATABASE_URL isn't set: Netlify → Site configuration → Environment variables → add DATABASE_URL with your Neon connection string, then redeploy.";
  if (m.includes("401")) return "Not authorised (401). Sign out and back in; if it persists, check Identity is enabled in Netlify (Site configuration → Identity).";
  if (m.includes("timed out")) return "The sync server didn't respond in time. Your changes are safe on this device and will retry on the next edit — if this keeps happening, check the connection or the Netlify function logs.";
  if (m.toLowerCase().includes("fetch") || m.toLowerCase().includes("network")) return "Network error reaching the sync endpoint. Check your connection, or the site may still be deploying.";
  return `Sync error: ${m}`;
}

/* ---------- theme ---------- */
const THEMES = {
  light: {
    mode: "light", bg: "#f2f2f7", surface: "#ffffff", surface2: "#f2f2f7", input: "#eeeef2",
    border: "#e5e5ea", gridLine: "#ececf0", text: "#1c1c1e", dim: "#8e8e93", faint: "#c7c7cc",
    shade: "#f7f7f9", hover: "#f4f4f6", accent: "#0a84ff", danger: "#ff3b30", ok: "#30d158",
    shadow: "0 8px 30px rgba(0,0,0,0.12)",
  },
  dark: {
    mode: "dark", bg: "#000000", surface: "#161618", surface2: "#232326", input: "#232326",
    border: "#2e2e31", gridLine: "#242427", text: "#f2f2f7", dim: "#98989f", faint: "#55555a",
    shade: "#0c0c0e", hover: "#232326", accent: "#0a84ff", danger: "#ff453a", ok: "#30d158",
    shadow: "0 8px 30px rgba(0,0,0,0.6)",
  },
};
const ThemeCtx = createContext(THEMES.dark);
const useT = () => useContext(ThemeCtx);

const ACCENTS = { blue: "#0a84ff", red: "#ff453a", orange: "#ff9f0a", green: "#30d158", purple: "#bf5af2", gray: "#8e8e93" };
const LIGHT_TINT = { blue: ["#e8f1fe", "#0a5dc2"], red: ["#fdeaea", "#c0332b"], orange: ["#fef1e2", "#b06400"], green: ["#e7f6ec", "#1b7d3a"], purple: ["#f2ecfd", "#7d3ab3"], gray: ["#f0f0f2", "#5a5a5f"] };
const DARK_TINT = { blue: ["#0a84ff2b", "#8ec5ff"], red: ["#ff453a2b", "#ff9d97"], orange: ["#ff9f0a2b", "#ffc46b"], green: ["#30d1582b", "#7fe3a0"], purple: ["#bf5af22b", "#dcaaf8"], gray: ["#8e8e932b", "#c7c7cc"] };
function colorSet(name, mode) {
  const a = ACCENTS[name] || ACCENTS.blue;
  const [bg, text] = (mode === "dark" ? DARK_TINT : LIGHT_TINT)[name] || (mode === "dark" ? DARK_TINT : LIGHT_TINT).blue;
  return { border: a, bg, text };
}
const PRIORITY = { 1: { label: "High", c: "red" }, 2: { label: "Medium", c: "orange" }, 3: { label: "Low", c: "blue" } };
const prioSet = (p, mode) => ({ ...colorSet(PRIORITY[p]?.c || "blue", mode), dot: ACCENTS[PRIORITY[p]?.c || "blue"], label: PRIORITY[p]?.label || "Low" });

const DEFAULT_CATEGORIES = [
  { id: "work", name: "Work", hours: { 0: null, 1: { start: 540, end: 1140 }, 2: { start: 540, end: 1140 }, 3: { start: 540, end: 1140 }, 4: { start: 540, end: 1140 }, 5: { start: 540, end: 1140 }, 6: null }, overrides: {} },
  { id: "personal", name: "Personal", hours: { 0: { start: 600, end: 1320 }, 1: { start: 1140, end: 1320 }, 2: { start: 1140, end: 1320 }, 3: { start: 1140, end: 1320 }, 4: { start: 1140, end: 1320 }, 5: { start: 1140, end: 1320 }, 6: { start: 600, end: 1320 } }, overrides: {} },
];

function migrate(d) {
  const out = { tasks: d.tasks || [], events: d.events || [], categories: d.categories };
  if (!out.categories) {
    const cats = JSON.parse(JSON.stringify(DEFAULT_CATEGORIES));
    if (d.settings && d.settings.workStart != null) {
      for (let i = 0; i < 7; i++) cats[0].hours[i] = (d.settings.days || [1, 2, 3, 4, 5]).includes(i) ? { start: d.settings.workStart, end: d.settings.workEnd } : null;
    }
    out.categories = cats;
  }
  out.tasks = out.tasks.map((t) => ({ category: "work", scheduledAt: null, autoReschedule: true, completedSlot: null, dependsOn: null, waitingOn: null, notes: "", checklist: [], ...t }));
  out.defaultCat = d.defaultCat && out.categories.some((c) => c.id === d.defaultCat) ? d.defaultCat : (out.categories[0] && out.categories[0].id) || "work";
  out.events = out.events.map((e) => ({ tz: deviceTz, repeat: "none", allDay: false, endDate: null, timeOff: false, exceptions: [], location: null, notes: "", checklist: [], calId: null, ...e }));
  out.waiting = d.waiting || [];
  out.icsCals = d.icsCals || [];
  out.userCals = d.userCals || [];
  out.holidayCals = d.holidayCals || [];
  /* pre-ICS Nager cache is dead data (and held observed dates like
     Independence Day on Jul 3) — hard-empty it so it drains from the DB */
  out.holidayCache = {};
  out.country = d.country || guessCountry();
  return out;
}

/* ---------- atoms ---------- */
function TimeSelect({ value, onChange, from = 0, to = 1440, step = 15, disabled }) {
  const T = useT();
  const opts = [];
  for (let m = from; m <= to; m += step) opts.push(m);
  /* imported/accepted events carry exact minutes (1:55 PM) that aren't on
     the step grid — inject the live value so the select can display it,
     instead of the browser silently showing its first option */
  if (value != null && Number.isFinite(value) && !opts.includes(value)) {
    opts.push(value);
    opts.sort((a, b) => a - b);
  }
  return (
    <select value={value} onChange={(e) => onChange(Number(e.target.value))} disabled={disabled}
      className="rounded-md px-2 py-1 text-sm disabled:opacity-40"
      style={{ background: T.surface2, color: T.text, border: `1px solid ${T.border}` }}>
      {opts.map((m) => <option key={m} value={m}>{toAmPm(m)}</option>)}
    </select>
  );
}

function Check({ checked, onToggle, color = "#5b8def" }) {
  const T = useT();
  return (
    <button onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onToggle(); }}
      className="flex-shrink-0 rounded-full flex items-center justify-center transition-all"
      style={{ width: 18, height: 18, border: `1.5px solid ${checked ? color : T.faint}`, background: checked ? color : "transparent" }}
      aria-label={checked ? "Mark incomplete" : "Mark complete"}>
      {checked && <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 5.2 L4.2 7.4 L8 2.8" stroke="white" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>}
    </button>
  );
}

function Switch({ on, onToggle, label }) {
  const T = useT();
  return (
    <button onClick={onToggle} className="rounded-full relative transition-colors flex-shrink-0" aria-label={label}
      style={{ width: 40, height: 24, background: on ? T.ok : (T.mode === "dark" ? "#3a3a3e" : "#d9d9de") }}>
      <span className="absolute top-0.5 rounded-full bg-white shadow transition-all" style={{ width: 20, height: 20, left: on ? 18 : 2 }} />
    </button>
  );
}

function Modal({ title, onClose, children, footer, wide }) {
  const T = useT();
  /* bottom sheet on phones, centred card on desktop */
  const sheet = typeof window !== "undefined" && window.innerWidth < 640;
  return (
    <div className={`fixed inset-0 z-50 flex ${sheet ? "items-end" : "items-center justify-center p-4"}`} style={{ background: "rgba(0,0,0,0.45)" }} onClick={onClose}>
      <div
        className={sheet ? "rl-sheet w-full rounded-t-2xl overflow-y-auto" : `rounded-2xl w-full ${wide ? "max-w-lg" : "max-w-sm"} max-h-full overflow-y-auto`}
        onClick={(e) => e.stopPropagation()}
        style={{ background: T.surface, boxShadow: T.shadow, border: sheet ? "none" : `1px solid ${T.border}`, maxHeight: sheet ? "88vh" : undefined, paddingBottom: sheet ? "env(safe-area-inset-bottom)" : 0 }}>
        {sheet && (
          <div className="flex justify-center pt-2" onClick={onClose}>
            <div style={{ width: 36, height: 4, borderRadius: 2, background: T.faint }} />
          </div>
        )}
        <div className={`px-5 ${sheet ? "pt-2" : "pt-4"} pb-2 flex items-center justify-between sticky top-0 ${sheet ? "" : "rounded-t-2xl"}`} style={{ background: T.surface }}>
          <h3 className="font-semibold text-base" style={{ color: T.text }}>{title}</h3>
          <button onClick={onClose} className="text-sm px-1" style={{ color: T.dim }}>✕</button>
        </div>
        <div className="px-5 pb-4">{children}</div>
        {footer && <div className="px-5 pb-4 flex gap-2 justify-end items-center flex-wrap">{footer}</div>}
      </div>
    </div>
  );
}

function Row({ label, children }) {
  const T = useT();
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs flex-shrink-0" style={{ color: T.dim, width: 62 }}>{label}</span>
      {children}
    </div>
  );
}

const inputStyle = (T) => ({ background: T.input, color: T.text, border: "1px solid transparent", outline: "none" });
const selStyle = (T) => ({ background: T.surface2, color: T.text, border: `1px solid ${T.border}` });

/* ---------- unified event / task editor ---------- */
function ItemModal({ draft, events, tasks = [], waiting = [], userCals = [], categories, onSaveEvent, onSaveTask, onDeleteSeries, onDeleteOccurrence, onDeleteTask, onClose }) {
  const T = useT();
  const isNew = !draft.id;
  const [itemType, setItemType] = useState(draft.itemType || "event");

  /* shared */
  const [title, setTitle] = useState(draft.title || "");
  /* event fields */
  const [date, setDate] = useState(draft.date || dateKey(new Date()));
  const [start, setStart] = useState(draft.start ?? 540);
  const [end, setEnd] = useState(draft.end ?? 600);
  const [allDay, setAllDay] = useState(!!draft.allDay);
  const [endDate, setEndDate] = useState(draft.endDate || draft.date || dateKey(new Date()));
  const [tz, setTz] = useState(draft.tz || deviceTz);
  const [tzFromLocation, setTzFromLocation] = useState(false);
  const [repeat, setRepeat] = useState(draft.repeat || "none");
  const [repeatUntil, setRepeatUntil] = useState(draft.repeatUntil || "");
  const [color, setColor] = useState(draft.color || "blue");
  const [location, setLocation] = useState(draft.location || null);
  const [locQuery, setLocQuery] = useState("");
  const [locResults, setLocResults] = useState([]);
  const [locBusy, setLocBusy] = useState(false);
  const [showSuggest, setShowSuggest] = useState(false);
  const locTimer = useRef(null);
  const locAbort = useRef(null);
  /* task fields */
  const [duration, setDuration] = useState(draft.duration || (draft.end != null && draft.start != null ? Math.max(15, draft.end - draft.start) : 60));
  const [priority, setPriority] = useState(draft.priority || 2);
  const [category, setCategory] = useState(draft.category || categories[0]?.id);
  const [deadline, setDeadline] = useState(draft.deadline || "");
  const [pickTime, setPickTime] = useState(!!draft.scheduledAt || (isNew && draft.start != null && draft.fromGrid));
  const [taskDate, setTaskDate] = useState(draft.scheduledAt?.date || draft.date || dateKey(new Date()));
  const [taskStart, setTaskStart] = useState(draft.scheduledAt?.start ?? draft.start ?? 540);
  const [autoReschedule, setAutoReschedule] = useState(draft.autoReschedule !== false);
  const [dependsOn, setDependsOn] = useState(draft.dependsOn || "");
  const [waitingFor, setWaitingFor] = useState(draft.waitingOn || "");
  const [calId, setCalId] = useState(draft.calId || "");
  const [notes, setNotes] = useState(draft.notes || "");
  const [checklist, setChecklist] = useState(() => (draft.checklist || []).map((c) => ({ ...c })));
  const [newCheck, setNewCheck] = useState("");
  const [confirmAsk, setConfirmAsk] = useState(null); /* in-app dialog: native confirm dialogs are unreliable in installed PWAs */
  const addCheck = () => {
    if (!newCheck.trim()) return;
    setChecklist((cs) => [...cs, { id: uid(), text: newCheck.trim(), done: false }]);
    setNewCheck("");
  };
  const noteLinks = useMemo(() => (notes.match(/https?:\/\/[^\s]+/g) || []).slice(0, 4), [notes]);

  /* prerequisite choices: other pending tasks, excluding anything that
     (transitively) depends on this task — picking those would make a cycle */
  const depOptions = useMemo(() => {
    if (itemType !== "task") return [];
    const byId = {};
    for (const t of tasks) byId[t.id] = t;
    const chainsBackTo = (t, target) => {
      let cur = t, hops = 0;
      while (cur && cur.dependsOn && hops++ < 50) {
        if (cur.dependsOn === target) return true;
        cur = byId[cur.dependsOn];
      }
      return false;
    };
    return tasks.filter((t) => !t.done && t.id !== draft.id && !(draft.id && chainsBackTo(t, draft.id)));
  }, [tasks, draft.id, itemType]);

  const suggestions = useMemo(() => {
    if (itemType !== "event") return [];
    const byTitle = {};
    for (const e of events) {
      const k = (e.title || "").trim().toLowerCase();
      if (!k) continue;
      byTitle[k] = byTitle[k] || { count: 0, latest: e };
      byTitle[k].count += 1;
      if ((e.createdAt || 0) >= (byTitle[k].latest.createdAt || 0)) byTitle[k].latest = e;
    }
    const q = title.trim().toLowerCase();
    return Object.entries(byTitle)
      .filter(([k, v]) => v.count >= 3 && (!q || k.includes(q)) && k !== q)
      .sort((a, b) => b[1].count - a[1].count).slice(0, 5).map(([, v]) => v);
  }, [events, title, itemType]);

  const pickSuggestion = (s) => {
    const e = s.latest;
    setTitle(e.title); setColor(e.color || "blue"); setAllDay(!!e.allDay);
    if (!e.allDay) { setStart(e.start); setEnd(e.end); }
    setTz(e.tz || deviceTz); setLocation(e.location || null); setShowSuggest(false);
  };

  /* location search — Photon (fast) with Nominatim fallback */
  const searchLocation = (q) => {
    setLocQuery(q);
    clearTimeout(locTimer.current);
    if (q.trim().length < 2) { setLocResults([]); setLocBusy(false); return; }
    setLocBusy(true);
    locTimer.current = setTimeout(async () => {
      locAbort.current?.abort();
      const ctrl = new AbortController();
      locAbort.current = ctrl;
      try {
        const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=5`, { signal: ctrl.signal });
        const j = await r.json();
        setLocResults((j.features || []).map((f, i) => ({
          id: i,
          name: [f.properties.name, f.properties.city || f.properties.state || f.properties.country].filter(Boolean).join(", "),
          lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0],
        })));
        setLocBusy(false);
      } catch (err) {
        if (err.name === "AbortError") return;
        try {
          const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
          const j = await r.json();
          setLocResults(j.map((x) => ({ id: x.place_id, name: x.display_name.split(",").slice(0, 2).join(","), lat: +x.lat, lon: +x.lon })));
        } catch { setLocResults([]); }
        setLocBusy(false);
      }
    }, 250);
  };

  const pickLocation = (r) => {
    setLocation({ name: r.name, lat: r.lat, lon: r.lon });
    setLocQuery(""); setLocResults([]);
    try {
      const z = tzlookup(r.lat, r.lon);
      if (z && z !== tz) { setTz(z); setTzFromLocation(true); }
    } catch { /* ocean / no zone */ }
  };

  const zones = useMemo(() => timeZoneList(), []);
  const localPreview = useMemo(() => {
    if (allDay || tz === deviceTz) return null;
    const w = utcToWall(wallToUtc(date, start, tz), deviceTz);
    return `${w.date === date ? "" : w.date + " "}${toAmPm(w.minutes)} your time`;
  }, [date, start, tz, allDay]);

  const commit = () => {
    if (itemType === "timeoff") {
      onSaveEvent({
        exceptions: [], createdAt: Date.now(), ...draft,
        id: draft.id || uid(), title: title.trim() || "Time off",
        date, endDate: endDate > date ? endDate : date,
        allDay: true, timeOff: true, start: 0, end: 1440,
        tz: deviceTz, color: "red", repeat: "none", repeatUntil: null, location: null,
        notes, checklist,
      });
      return;
    }
    if (!title.trim()) return;
    if (itemType === "event") {
      /* keep the timed start/end even while all-day, so toggling back
         restores the original hours instead of snapping to 00:00-24:00 */
      const timedStart = start, timedEnd = Math.max(end, start + 15);
      onSaveEvent({
        exceptions: [], createdAt: Date.now(), ...draft,
        id: draft.id || uid(), title: title.trim(), date, allDay,
        endDate: allDay && endDate > date ? endDate : null,
        start: timedStart, end: timedEnd,
        tz, color, location, repeat,
        repeatUntil: repeat !== "none" && repeatUntil ? repeatUntil : null,
        notes, checklist, calId: calId || null,
      });
    } else {
      onSaveTask({
        done: false, createdAt: Date.now(), completedSlot: null, ...draft,
        id: draft.id || uid(), title: title.trim(),
        duration, priority, category, deadline: deadline || null,
        scheduledAt: pickTime ? { date: taskDate, start: taskStart } : null,
        autoReschedule,
        dependsOn: dependsOn || null,
        waitingOn: waitingFor || null,
        notes, checklist,
      });
    }
  };

  const seg = (t, label) => (
    <button onClick={() => setItemType(t)} className="flex-1 py-1.5 text-xs font-semibold rounded-lg transition-colors"
      style={{ background: itemType === t ? T.accent : "transparent", color: itemType === t ? "white" : T.dim }}>{label}</button>
  );

  const typeName = itemType === "event" ? "Event" : itemType === "timeoff" ? "Time Off" : "Task";
  return (
    <Modal title={`${isNew ? "New" : "Edit"} ${typeName}`} onClose={onClose}
      footer={
        <>
          {!isNew && (itemType === "event" || itemType === "timeoff") && repeat !== "none" && draft.occDate && (
            <button onClick={() => setConfirmAsk({ title: "Delete this occurrence only?", run: () => onDeleteOccurrence(draft.id, draft.occDate) })} className="px-2 py-1.5 text-xs font-medium" style={{ color: T.danger }}>Delete this day</button>
          )}
          {!isNew && (itemType === "event" || itemType === "timeoff") && (
            <button onClick={() => setConfirmAsk({ title: repeat !== "none" ? "Delete the whole series?" : "Delete this event?", run: () => onDeleteSeries(draft.id) })} className="px-2 py-1.5 text-xs font-medium" style={{ color: T.danger }}>{repeat !== "none" ? "Delete series" : "Delete"}</button>
          )}
          {!isNew && itemType === "task" && (
            <button onClick={() => setConfirmAsk({ title: "Delete this task?", run: () => onDeleteTask(draft.id) })} className="px-2 py-1.5 text-xs font-medium" style={{ color: T.danger }}>Delete</button>
          )}
          <div className="flex-1" />
          <button onClick={commit} className="px-4 py-1.5 rounded-lg text-sm font-semibold text-white" style={{ background: T.accent }}>{isNew ? "Add" : "Save"}</button>
        </>
      }>
      <div className="flex flex-col gap-3">
        {isNew && (
          <div className="flex rounded-xl p-0.5" style={{ background: T.surface2 }}>
            {seg("event", "Event")}{seg("task", "Task")}{seg("timeoff", "Time off")}
          </div>
        )}

        <div className="relative">
          <input autoFocus={!window.matchMedia("(pointer: coarse)").matches} value={title}
            onChange={(e) => { setTitle(e.target.value); setShowSuggest(true); }}
            onFocus={() => setShowSuggest(true)} onBlur={() => setTimeout(() => setShowSuggest(false), 150)}
            placeholder="Title" className="w-full rounded-lg px-3 py-2 text-sm" style={inputStyle(T)} />
          {showSuggest && suggestions.length > 0 && (
            <div className="absolute left-0 right-0 mt-1 rounded-lg z-10 overflow-hidden" style={{ background: T.surface2, boxShadow: T.shadow, border: `1px solid ${T.border}` }}>
              {suggestions.map((s) => (
                <button key={s.latest.id} onMouseDown={(e) => { e.preventDefault(); pickSuggestion(s); }}
                  className="w-full text-left px-3 py-2 text-sm rl-hover flex items-center gap-2" style={{ color: T.text }}>
                  <span className="rounded-full flex-shrink-0" style={{ width: 8, height: 8, background: ACCENTS[s.latest.color] || ACCENTS.blue }} />
                  <span className="flex-1 truncate">{s.latest.title}</span>
                  <span className="text-[10px]" style={{ color: T.dim }}>used {s.count}×</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {itemType === "timeoff" ? (
          <>
            <Row label="Starts"><input type="date" value={date} onChange={(e) => { setDate(e.target.value); if (endDate < e.target.value) setEndDate(e.target.value); }} className="rounded-md px-2 py-1 text-sm" style={selStyle(T)} /></Row>
            <Row label="Ends"><input type="date" value={endDate} min={date} onChange={(e) => setEndDate(e.target.value < date ? date : e.target.value)} className="rounded-md px-2 py-1 text-sm" style={selStyle(T)} /></Row>
            <p className="text-[11px] -mt-1" style={{ color: T.dim }}>🏖 No tasks will be auto-scheduled on these days — everything rolls to the other side.</p>
          </>
        ) : itemType === "event" ? (
          <>
            <Row label="All-day"><Switch on={allDay} onToggle={() => setAllDay(!allDay)} label="Toggle all-day" /></Row>
            <Row label={allDay ? "Starts" : "Date"}><input type="date" value={date} onChange={(e) => { setDate(e.target.value); if (endDate < e.target.value) setEndDate(e.target.value); }} className="rounded-md px-2 py-1 text-sm" style={selStyle(T)} /></Row>
            {allDay && <Row label="Ends"><input type="date" value={endDate} min={date} onChange={(e) => setEndDate(e.target.value < date ? date : e.target.value)} className="rounded-md px-2 py-1 text-sm" style={selStyle(T)} /></Row>}
            {!allDay && (
              <>
                <Row label="Starts"><TimeSelect value={start} onChange={(v) => { setStart(v); if (end <= v) setEnd(Math.min(v + 60, 1440)); }} /></Row>
                <Row label="Ends"><TimeSelect value={end} onChange={setEnd} from={start + 15} /></Row>
                <Row label="Time zone">
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <select value={tz} onChange={(e) => { setTz(e.target.value); setTzFromLocation(false); }} className="rounded-md px-2 py-1 text-sm max-w-full" style={{ ...selStyle(T), maxWidth: 220 }}>
                      {!zones.includes(tz) && <option value={tz}>{tz}</option>}
                      {zones.map((z) => <option key={z} value={z}>{z}</option>)}
                    </select>
                    <span className="text-[10px]" style={{ color: T.dim }}>{tzLabel(tz)}{tzFromLocation ? " · set from location" : ""}{localPreview ? ` · shows as ${localPreview}` : ""}</span>
                  </div>
                </Row>
              </>
            )}
            {userCals.length > 0 && (
              <Row label="Calendar">
                <select value={calId} onChange={(e) => setCalId(e.target.value)} className="rounded-md px-2 py-1 text-sm" style={selStyle(T)}>
                  <option value="">Default</option>
                  {userCals.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Row>
            )}
            <Row label="Repeat">
              <select value={repeat} onChange={(e) => setRepeat(e.target.value)} className="rounded-md px-2 py-1 text-sm" style={selStyle(T)}>
                <option value="none">Never</option><option value="daily">Every day</option><option value="weekdays">Weekdays</option>
                <option value="weekly">Every week</option><option value="monthly">Every month</option><option value="yearly">Every year</option>
              </select>
              {repeat !== "none" && <input type="date" value={repeatUntil} onChange={(e) => setRepeatUntil(e.target.value)} title="Repeat until (optional)" className="rounded-md px-2 py-1 text-xs" style={selStyle(T)} />}
            </Row>
            {repeat !== "none" && !isNew && <p className="text-[10px] -mt-2" style={{ color: T.dim }}>Changes apply to every occurrence in the series.</p>}
            <Row label="Location">
              <div className="flex-1 min-w-0">
                {location ? (
                  <div className="flex items-center gap-2">
                    <a href={`https://www.google.com/maps/search/?api=1&query=${location.lat},${location.lon}`} target="_blank" rel="noreferrer"
                      className="flex-1 truncate text-sm font-medium inline-flex items-center gap-1" style={{ color: T.accent }} title="Open in Google Maps"><Icon name="mapPin" size={13} sw={2} />{location.name}</a>
                    <button onClick={() => setLocation(null)} className="text-xs px-1" style={{ color: T.dim }}>✕</button>
                  </div>
                ) : (
                  <div className="relative">
                    <input value={locQuery} onChange={(e) => searchLocation(e.target.value)} placeholder="Search a place…"
                      className="w-full rounded-lg px-3 py-1.5 text-sm" style={inputStyle(T)} />
                    {locBusy && <span className="absolute right-2 top-1.5 text-[10px]" style={{ color: T.dim }}>…</span>}
                    {locResults.length > 0 && (
                      <div className="absolute left-0 right-0 mt-1 rounded-lg z-10 overflow-hidden" style={{ background: T.surface2, boxShadow: T.shadow, border: `1px solid ${T.border}` }}>
                        {locResults.map((r) => (
                          <button key={r.id} onMouseDown={(e) => { e.preventDefault(); pickLocation(r); }}
                            className="w-full text-left px-3 py-2 text-xs rl-hover truncate" style={{ color: T.text }}>{r.name}</button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </Row>
            <Row label="Color">
              <div className="flex gap-2">
                {Object.keys(ACCENTS).map((c) => (
                  <button key={c} onClick={() => setColor(c)} className="rounded-full" aria-label={c}
                    style={{ width: 20, height: 20, background: ACCENTS[c], outline: color === c ? `2px solid ${ACCENTS[c]}` : "none", outlineOffset: 2 }} />
                ))}
              </div>
            </Row>
          </>
        ) : (
          <>
            <Row label="Priority">
              <div className="flex gap-1.5">
                {[1, 2, 3].map((p) => {
                  const ps = prioSet(p, T.mode);
                  return (
                    <button key={p} onClick={() => setPriority(p)} className="rounded-full text-xs font-medium px-3 py-1.5"
                      style={{ background: priority === p ? ps.dot : T.surface2, color: priority === p ? "white" : T.dim }}>{ps.label}</button>
                  );
                })}
              </div>
            </Row>
            <Row label="Duration">
              <select value={duration} onChange={(e) => setDuration(Number(e.target.value))} className="rounded-md px-2 py-1 text-sm" style={selStyle(T)}>
                {[15, 30, 45, 60, 90, 120, 180, 240, 300, 360].map((m) => <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} hr${m > 60 ? "s" : ""}`}</option>)}
              </select>
            </Row>
            <Row label="Category">
              <select value={category} onChange={(e) => setCategory(e.target.value)} className="rounded-md px-2 py-1 text-sm" style={selStyle(T)}>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Row>
            <Row label="After">
              <div className="flex flex-col gap-0.5 min-w-0">
                <select value={dependsOn} onChange={(e) => setDependsOn(e.target.value)} className="rounded-md px-2 py-1 text-sm max-w-full" style={{ ...selStyle(T), maxWidth: 220 }}>
                  <option value="">— nothing —</option>
                  {depOptions.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
                </select>
                {dependsOn && <span className="text-[10px]" style={{ color: T.dim }}>won't be scheduled until that task's slot ends</span>}
              </div>
            </Row>
            <Row label="Waiting for">
              <div className="flex flex-col gap-0.5 min-w-0">
                <select value={waitingFor} onChange={(e) => setWaitingFor(e.target.value)} className="rounded-md px-2 py-1 text-sm max-w-full" style={{ ...selStyle(T), maxWidth: 220 }}>
                  <option value="">— nothing —</option>
                  {waiting.filter((w) => !w.done || w.id === waitingFor).map((w) => <option key={w.id} value={w.id}>{w.title}</option>)}
                </select>
                {waitingFor && <span className="text-[10px]" style={{ color: T.dim }}>hidden from the calendar until this is checked off</span>}
              </div>
            </Row>
            <Row label="When">
              <div className="flex flex-col gap-1.5">
                <div className="flex gap-1.5">
                  <button onClick={() => setPickTime(false)} className="rounded-full text-xs font-medium px-3 py-1.5" style={{ background: !pickTime ? T.accent : T.surface2, color: !pickTime ? "white" : T.dim }}>Next free slot</button>
                  <button onClick={() => setPickTime(true)} className="rounded-full text-xs font-medium px-3 py-1.5" style={{ background: pickTime ? T.accent : T.surface2, color: pickTime ? "white" : T.dim }}>Pick a time</button>
                </div>
                {pickTime && (
                  <div className="flex gap-1.5 items-center">
                    <input type="date" value={taskDate} onChange={(e) => setTaskDate(e.target.value)} className="rounded-md px-2 py-1 text-xs" style={selStyle(T)} />
                    <TimeSelect value={taskStart} onChange={setTaskStart} />
                  </div>
                )}
              </div>
            </Row>
            <Row label="If missed">
              <div className="flex items-center gap-2">
                <Switch on={autoReschedule} onToggle={() => setAutoReschedule(!autoReschedule)} label="Auto-reschedule" />
                <span className="text-xs" style={{ color: T.dim }}>{autoReschedule ? "rolls to the next free slot" : "stays put (shows overdue)"}</span>
              </div>
            </Row>
            <Row label="Deadline"><input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} className="rounded-md px-2 py-1 text-sm" style={selStyle(T)} /></Row>
          </>
        )}

        {/* notes + checklist apply to every item type */}
        <div className="flex items-start gap-2">
          <span className="text-xs flex-shrink-0 pt-1.5" style={{ color: T.dim, width: 62 }}>Notes</span>
          <div className="flex-1 min-w-0">
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
              placeholder="Links, details… (e.g. the recipe URL)"
              className="w-full rounded-lg px-3 py-2 text-sm resize-y" style={inputStyle(T)} />
            {noteLinks.length > 0 && (
              <div className="flex gap-1.5 flex-wrap mt-1">
                {noteLinks.map((u, i) => {
                  let host = u;
                  try { host = new URL(u).hostname.replace(/^www\./, ""); } catch { /* keep raw */ }
                  return (
                    <a key={i} href={u} target="_blank" rel="noreferrer" className="rounded-full px-2 py-0.5 text-[10px] font-medium inline-flex items-center gap-1"
                      style={{ background: T.surface2, color: T.accent }}>
                      <Icon name="link" size={9} sw={2.2} />{host}
                    </a>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-start gap-2">
          <span className="text-xs flex-shrink-0 pt-1.5" style={{ color: T.dim, width: 62 }}>Checklist</span>
          <div className="flex-1 min-w-0 flex flex-col gap-1">
            {checklist.map((c) => (
              <div key={c.id} className="flex items-center gap-2">
                <Check checked={c.done} onToggle={() => setChecklist((cs) => cs.map((x) => (x.id === c.id ? { ...x, done: !x.done } : x)))} color={T.ok} />
                <span className={`flex-1 text-sm truncate ${c.done ? "line-through" : ""}`} style={{ color: c.done ? T.faint : T.text }}>{c.text}</span>
                <button onClick={() => setChecklist((cs) => cs.filter((x) => x.id !== c.id))} className="text-xs px-1" style={{ color: T.faint }} aria-label="Remove item">✕</button>
              </div>
            ))}
            <div className="flex gap-1.5">
              <input value={newCheck} onChange={(e) => setNewCheck(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addCheck()}
                placeholder="Add item…" className="flex-1 rounded-lg px-3 py-1.5 text-sm min-w-0" style={inputStyle(T)} />
              <button onClick={addCheck} className="rounded-lg text-white font-bold text-sm px-2.5" style={{ background: T.accent }}>＋</button>
            </div>
          </div>
        </div>
      </div>
      {confirmAsk && (
        <div className="fixed inset-0 flex items-center justify-center p-8" style={{ background: "rgba(0,0,0,0.5)", zIndex: 70 }} onClick={() => setConfirmAsk(null)}>
          <div className="rounded-2xl w-full max-w-xs px-4 py-4" style={{ background: T.surface, boxShadow: T.shadow }} onClick={(e) => e.stopPropagation()}>
            <div className="text-sm font-semibold mb-1" style={{ color: T.text }}>{confirmAsk.title}</div>
            <div className="text-xs mb-3.5" style={{ color: T.dim }}>This can't be undone.</div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmAsk(null)} className="rounded-lg px-3 py-1.5 text-xs font-medium" style={{ background: T.surface2, color: T.text }}>Cancel</button>
              <button onClick={() => { const r = confirmAsk.run; setConfirmAsk(null); r(); }} className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white" style={{ background: T.danger }}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ---------- categories / hours editor ---------- */
function NotifDiagnostics() {
  const T = useT();
  const [st, setSt] = useState(null);
  const [test, setTest] = useState("");
  useEffect(() => {
    (async () => {
      try {
        const auth = await getAuthHeader();
        if (!auth) return;
        const r = await fetch("/.netlify/functions/notify?status=1", { headers: { Authorization: auth } });
        setSt(await r.json());
      } catch { setSt({ error: true }); }
    })();
  }, []);
  const sendTest = async () => {
    setTest("sending…");
    try {
      const auth = await getAuthHeader();
      const r = await fetch("/.netlify/functions/notify", { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify({ test: 1 }) });
      const j = await r.json();
      setTest(j.ok ? `sent to ${j.sent} device${j.sent === 1 ? "" : "s"} — should arrive in seconds` : j.error || (j.errors || []).join(", ") || "failed");
    } catch (err) { setTest(String(err?.message || err)); }
  };
  const age = st?.scheduleUpdated ? Math.round((Date.now() - new Date(st.scheduleUpdated).getTime()) / 60000) : null;
  return (
    <div className="mt-2 rounded-xl px-3 py-2" style={{ background: T.surface2 }}>
      {st ? st.error ? <p className="text-[11px]" style={{ color: T.danger }}>couldn't reach the notify function</p> : (
        <>
          {!st.vapidComplete && <p className="text-[11px] mb-1" style={{ color: T.danger }}>Server is missing VAPID_PRIVATE_KEY or VAPID_SUBJECT — scheduled sends are skipped until set.</p>}
          <p className="text-[11px]" style={{ color: T.dim }}>
            {st.devices} device{st.devices === 1 ? "" : "s"} subscribed · {st.scheduled} item{st.scheduled === 1 ? "" : "s"} scheduled{age != null ? ` · updated ${age}m ago` : " · nothing uploaded yet"}
          </p>
        </>
      ) : <p className="text-[11px]" style={{ color: T.dim }}>checking…</p>}
      <div className="flex items-center gap-2 mt-1.5">
        <button onClick={sendTest} className="rounded-lg px-2.5 py-1 text-[11px] font-medium" style={{ background: T.surface, color: T.accent }}>Send test notification</button>
        {test && <span className="text-[10px]" style={{ color: T.dim }}>{test}</span>}
      </div>
    </div>
  );
}

function CategoriesModal({ categories, defaultCat, onSave, onClose }) {
  const T = useT();
  const [cats, setCats] = useState(() => JSON.parse(JSON.stringify(categories)));
  const [defCat, setDefCat] = useState(defaultCat);
  const [sel, setSel] = useState(cats[0]?.id);
  const [ovDate, setOvDate] = useState("");
  const [ovOff, setOvOff] = useState(true);
  const [ovStart, setOvStart] = useState(540);
  const [ovEnd, setOvEnd] = useState(1140);
  const cat = cats.find((c) => c.id === sel);
  const patch = (fn) => setCats((cs) => cs.map((c) => (c.id === sel ? fn(JSON.parse(JSON.stringify(c))) : c)));

  return (
    <Modal title="Hours & Categories" onClose={onClose} wide
      footer={<button onClick={() => onSave(cats, cats.some((c) => c.id === defCat) ? defCat : cats[0]?.id)} className="px-4 py-1.5 rounded-lg text-sm font-semibold text-white" style={{ background: T.accent }}>Save</button>}>
      <p className="text-xs mb-3" style={{ color: T.dim }}>
        Tasks only roll over inside their category's hours. Add a dated exception for holidays or one-off changes.
      </p>
      <label className="flex items-center gap-2 text-xs mb-3" style={{ color: T.dim }}>
        Default for new tasks
        <select value={cats.some((c) => c.id === defCat) ? defCat : cats[0]?.id} onChange={(e) => setDefCat(e.target.value)}
          className="rounded-lg px-2 py-1 text-xs" style={{ background: T.surface2, color: T.text, border: "none" }}>
          {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      <div className="flex gap-1.5 mb-3 flex-wrap">
        {cats.map((c) => (
          <button key={c.id} onClick={() => setSel(c.id)} className="rounded-full text-xs font-medium px-3 py-1.5"
            style={{ background: sel === c.id ? T.accent : T.surface2, color: sel === c.id ? "white" : T.dim }}>{c.name}</button>
        ))}
        <button onClick={() => {
          const name = prompt("Category name");
          if (!name?.trim()) return;
          const id = uid();
          setCats((cs) => [...cs, { id, name: name.trim(), hours: { 0: null, 1: { start: 540, end: 1020 }, 2: { start: 540, end: 1020 }, 3: { start: 540, end: 1020 }, 4: { start: 540, end: 1020 }, 5: { start: 540, end: 1020 }, 6: null }, overrides: {} }]);
          setSel(id);
        }} className="rounded-full text-xs px-3 py-1.5" style={{ background: T.surface2, color: T.accent }}>+ New</button>
      </div>
      {cat && (
        <>
          <div className="flex flex-col gap-1.5 mb-4">
            {DOW.map((d, i) => {
              const h = cat.hours[i];
              return (
                <div key={d} className="flex items-center gap-2">
                  <button onClick={() => patch((c) => { c.hours[i] = h ? null : { start: 540, end: 1140 }; return c; })}
                    className="rounded-full text-xs font-medium py-1" style={{ width: 44, background: h ? T.accent : T.surface2, color: h ? "white" : T.dim }}>{d}</button>
                  {h ? (
                    <>
                      <TimeSelect value={h.start} onChange={(v) => patch((c) => { c.hours[i] = { start: v, end: Math.max(c.hours[i].end, v + 60) }; return c; })} />
                      <span className="text-xs" style={{ color: T.dim }}>to</span>
                      <TimeSelect value={h.end} onChange={(v) => patch((c) => { c.hours[i].end = v; return c; })} from={h.start + 60} />
                    </>
                  ) : <span className="text-xs" style={{ color: T.faint }}>Off — nothing scheduled</span>}
                </div>
              );
            })}
          </div>
          <div className="text-[10px] uppercase tracking-wide mb-1" style={{ color: T.dim }}>Exceptions (holidays & one-offs)</div>
          {Object.entries(cat.overrides || {}).sort().map(([k, v]) => (
            <div key={k} className="flex items-center gap-2 text-xs py-1">
              <span className="font-medium" style={{ color: T.text, width: 90 }}>{k}</span>
              <span style={{ color: v ? colorSet("green", T.mode).text : colorSet("red", T.mode).text }}>{v ? `${toAmPm(v.start)} – ${toAmPm(v.end)}` : "Off (holiday)"}</span>
              <button onClick={() => patch((c) => { delete c.overrides[k]; return c; })} className="px-1" style={{ color: T.dim }}>✕</button>
            </div>
          ))}
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <input type="date" value={ovDate} onChange={(e) => setOvDate(e.target.value)} className="rounded-md px-2 py-1 text-xs" style={selStyle(T)} />
            <button onClick={() => setOvOff(!ovOff)} className="rounded-full text-xs px-2.5 py-1"
              style={{ background: colorSet(ovOff ? "red" : "green", T.mode).bg, color: colorSet(ovOff ? "red" : "green", T.mode).text }}>
              {ovOff ? "Off (holiday)" : "Custom hours"}
            </button>
            {!ovOff && (<><TimeSelect value={ovStart} onChange={setOvStart} /><span className="text-xs" style={{ color: T.dim }}>to</span><TimeSelect value={ovEnd} onChange={setOvEnd} from={ovStart + 60} /></>)}
            <button onClick={() => { if (!ovDate) return; patch((c) => { c.overrides[ovDate] = ovOff ? null : { start: ovStart, end: ovEnd }; return c; }); setOvDate(""); }}
              className="rounded-lg text-xs font-semibold text-white px-2.5 py-1" style={{ background: T.accent }}>Add</button>
          </div>
        </>
      )}
    </Modal>
  );
}

/* ---------- calendar blocks (hoisted so re-renders never remount the grid) ---------- */
function blockGeom(lay, hourH, start, end) {
  const clippedEnd = Math.min(end, 1440);
  const base = { top: (start / 60) * hourH, height: Math.max(((clippedEnd - start) / 60) * hourH - 2, 16) };
  if (!lay || lay.mode === "full") return { ...base, left: 2, right: 4, indent: 0 };
  if (lay.mode === "split") {
    const gapPct = 100 / lay.cols;
    return { ...base, leftPct: lay.col * gapPct, widthPct: gapPct, split: true };
  }
  /* indent: bodies overlap but shift each column right so borders don't stack */
  const capH = lay.capMin != null && lay.capMin > start
    ? ((Math.min(lay.capMin, clippedEnd) - start) / 60) * hourH
    : null;
  return { ...base, left: 2 + lay.col * 10, right: 4, indent: lay.col, capH };
}
function geomStyle(g) {
  if (g.split) return { top: g.top, height: g.height, left: `calc(${g.leftPct}% + 1px)`, width: `calc(${g.widthPct}% - 3px)` };
  return { top: g.top, height: g.height, left: g.left, right: g.right };
}

/* suggestion payload times -> this device's wall clock when the email
   carried a pinned instant (Z / explicit offset); wall-only payloads pass
   through untouched */
function sugLocal(p) {
  if (p.allDay || p.startUtcMs == null) return { date: p.date, start: p.start, end: p.end };
  const sw = utcToWall(p.startUtcMs, deviceTz);
  let end;
  if (p.endUtcMs != null) {
    const ew = utcToWall(p.endUtcMs, deviceTz);
    end = ew.date === sw.date ? ew.minutes : 1440;
  } else end = Math.min(1440, sw.minutes + Math.max(15, (p.end ?? p.start + 60) - p.start));
  return { date: sw.date, start: sw.minutes, end: Math.max(end, sw.minutes + 15) };
}

function EventBlock({ occ, lay, hourH, dragPreview, beginDrag, openEvent, openMaps, editing }) {
  const T = useT();
  if (dragPreview && dragPreview.key === occ.renderKey) return null;
  const c = colorSet(occ.ev.color, T.mode);
  const start = occ.dispStart;
  const end = Math.min(occ.dispEnd, 1440);
  const g = blockGeom(lay, hourH, start, end);
  const compact = g.height < 34;
  const sug = !!occ.ev.suggestion;
  /* show at least one full line; never spill more than the block can hold,
     and stop above any overlapping later block (cascade mode) */
  const usableH = g.capH != null ? Math.min(g.height, g.capH) : g.height;
  const clampLines = Math.max(1, Math.floor((usableH - 4) / (compact ? 13.2 : 15)));
  return (
    <div className={`absolute rounded-lg select-none group/ev ${sug ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"}`}
      onPointerDown={(e) => beginDrag(e, { type: "event", occ }, "move")}
      onClick={(e) => { e.stopPropagation(); openEvent(occ); }}
      style={{ ...geomStyle(g), background: c.bg, ...(sug ? { border: `1.5px dashed ${c.border}`, opacity: 0.8 } : { borderLeft: `3px solid ${c.border}` }), ...(editing ? { boxShadow: `0 0 0 2px ${c.border}`, zIndex: 30 } : {}), zIndex: editing ? 30 : lay ? lay.z : 2, touchAction: "none" }}>
      <div className="px-1.5 py-0.5 pointer-events-none">
        <div className="text-xs font-semibold break-words" style={{ color: c.text, lineHeight: compact ? "1.1" : "1.25", display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: clampLines, overflow: "hidden" }}>
          {sug ? "? " : occ.ev.repeat && occ.ev.repeat !== "none" ? "↻ " : ""}{occ.ev.title}
        </div>
      </div>
      <div className={`absolute left-0 right-0 flex justify-center cursor-row-resize ${editing ? "opacity-100" : "opacity-0 group-hover/ev:opacity-100 pointer-events-none sm:pointer-events-auto"}`}
        onPointerDown={(e) => beginDrag(e, { type: "event", occ }, "resize-start")}
        style={{ touchAction: "none", top: editing ? -16 : 0, height: editing ? 32 : 8 }}>
        {editing ? (
          <div className="rounded-full" style={{ width: 18, height: 18, background: c.border, border: `3px solid ${T.bg}`, boxShadow: "0 1px 6px rgba(0,0,0,.45)", marginTop: 7 }} />
        ) : (
          <div className="rounded-full" style={{ width: 24, height: 3, background: c.border, opacity: 0.7, marginTop: 2 }} />
        )}
      </div>
      <div className={`absolute left-0 right-0 flex justify-center items-end cursor-row-resize ${editing ? "opacity-100" : "opacity-0 group-hover/ev:opacity-100 pointer-events-none sm:pointer-events-auto"}`}
        onPointerDown={(e) => beginDrag(e, { type: "event", occ }, "resize-end")}
        style={{ touchAction: "none", bottom: editing ? -16 : 0, height: editing ? 32 : 8 }}>
        {editing ? (
          <div className="rounded-full" style={{ width: 18, height: 18, background: c.border, border: `3px solid ${T.bg}`, boxShadow: "0 1px 6px rgba(0,0,0,.45)", marginBottom: 7 }} />
        ) : (
          <div className="rounded-full" style={{ width: 24, height: 3, background: c.border, opacity: 0.7, marginBottom: 2 }} />
        )}
      </div>
    </div>
  );
}

function TaskBlock({ item, lay, hourH, dragPreview, beginDrag, openTask, toggleTask, editing }) {
  const T = useT();
  const t = item.task;
  if (!item.done && dragPreview && dragPreview.key === "task_" + t.id) return null;
  const p = prioSet(item.effPriority || t.priority, T.mode);
  const done = !!item.done;
  const c = done ? colorSet("green", T.mode) : p;
  const overdue = !done && ((t.deadline && item.date > t.deadline) || item.overdue);
  const g = blockGeom(lay, hourH, item.start, item.end);
  const compact = g.height < 34;
  const usableH = g.capH != null ? Math.min(g.height, g.capH) : g.height;
  const clampLines = Math.max(1, Math.floor((usableH - 4) / (compact ? 13.2 : 15)));
  return (
    <div className={`absolute rounded-lg select-none group/tk ${done ? "" : "cursor-grab active:cursor-grabbing"}`}
      onPointerDown={(e) => { if (!done) beginDrag(e, { type: "task", item }, "move"); }}
      onClick={(e) => { e.stopPropagation(); openTask(t); }}
      style={{ ...geomStyle(g), background: c.bg, borderLeft: `3px dashed ${overdue ? T.danger : c.border}`, ...(editing ? { boxShadow: `0 0 0 2px ${c.border}` } : {}), zIndex: editing ? 30 : lay ? lay.z : 2, opacity: done ? 0.6 : 1, touchAction: done ? "auto" : "none" }}
      title={done ? "Completed" : item.pinned ? "Pinned time — drag to move" : "Auto-scheduled — drag to pin a time"}>
      <div className="px-1.5 py-0.5 pointer-events-none">
        <div className={`text-xs font-semibold break-words ${done ? "line-through" : ""}`} style={{ color: c.text, lineHeight: compact ? "1.1" : "1.25", display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: clampLines, overflow: "hidden" }}>
          {!done && item.chained && <Icon name="link" size={10} color={c.text} sw={2} style={{ display: "inline", marginRight: 3, verticalAlign: "-1px" }} />}
          {t.title}{overdue ? " · overdue" : ""}
        </div>
      </div>
      {!done && (
        <div className="absolute left-0 right-0 bottom-0 h-2 opacity-0 group-hover/tk:opacity-100 cursor-row-resize flex justify-center items-end"
          onPointerDown={(e) => beginDrag(e, { type: "task", item }, "resize-end")} style={{ touchAction: "none" }}>
          <div className="rounded-full mb-0.5" style={{ width: 24, height: 3, background: c.border, opacity: 0.7 }} />
        </div>
      )}
    </div>
  );
}

function GhostBlock({ preview, hourH }) {
  const T = useT();
  const start = preview.dispStart;
  const end = Math.min(preview.dispEnd, 1440);
  return (
    <div className="absolute left-0.5 right-1 rounded-lg px-1.5 py-0.5 overflow-hidden pointer-events-none"
      style={{ top: (start / 60) * hourH, height: Math.max(((end - start) / 60) * hourH - 2, 16), background: preview.cset.bg, borderLeft: `3px ${preview.dashed ? "dashed" : "solid"} ${preview.cset.border}`, zIndex: 20, boxShadow: T.shadow }}>
      <div className="text-xs font-semibold truncate" style={{ color: preview.cset.text }}>{preview.title}</div>
      <div className="text-[10px]" style={{ color: preview.cset.text, opacity: 0.75 }}>{toAmPm(start)} – {toAmPm(preview.dispEnd % 1440)}</div>
    </div>
  );
}

/* ---------- iOS-style week strip (mobile) ---------- */
function WeekStrip({ anchor, now, visibleN, onPickDay, onSwipeWeek }) {
  const T = useT();
  const ws = startOfWeek(anchor);
  const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
  const selStart = dateKey(anchor);
  const selEnd = dateKey(addDays(anchor, visibleN - 1));
  const gest = useRef(null);
  const swiped = useRef(false);
  return (
    <div className="flex px-1 pt-1 border-b select-none" style={{ borderColor: T.border, touchAction: "none" }}
      onPointerDown={(e) => {
        gest.current = { x: e.clientX, id: e.pointerId, fired: false };
        swiped.current = false;
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not supported */ }
      }}
      onPointerMove={(e) => {
        const g = gest.current;
        if (!g || g.id !== e.pointerId || g.fired) return;
        const dx = e.clientX - g.x;
        if (Math.abs(dx) > 35) {
          g.fired = true;
          swiped.current = true;
          onSwipeWeek(dx < 0 ? 1 : -1);
        }
      }}
      onPointerUp={() => { gest.current = null; }}
      onPointerCancel={() => { gest.current = null; }}>
      {days.map((d) => {
        const k = dateKey(d);
        const isToday = sameDay(d, now);
        const sel = k >= selStart && k <= selEnd;
        return (
          <button key={k} onClick={() => { if (swiped.current) { swiped.current = false; return; } onPickDay(d); }}
            className="flex-1 flex flex-col items-center gap-0.5 pb-1">
            <span className="text-[9px] font-semibold" style={{ color: T.dim }}>{DOW[d.getDay()][0]}</span>
            <span className="text-xs font-semibold rounded-full flex items-center justify-center"
              style={{ width: 26, height: 26, background: isToday ? T.danger : sel ? (T.mode === "dark" ? "#3a3a3e" : "#e4e4e9") : "transparent", color: isToday ? "white" : T.text }}>
              {d.getDate()}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ---------- time grid (week/day) ---------- */
function TimeGrid({ days, now, nowMin, hourH, isMobile, allDayByDay, timedByDay, tasksByDay, layoutFor, unionWindows, scrollRef, gridBodyRef, gutter, dragPreview, createPreview, beginDrag, beginCreate, onGridPointerDown, openEvent, openTask, toggleTask, openMaps, transition, editBlockId }) {
  const T = useT();
  const nowTop = (nowMin / 60) * hourH;
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="border-b" style={{ borderColor: T.border }}>
        <div className="flex" style={{ paddingRight: gutter }}>
          <div style={{ width: AXIS_W }} />
          {days.map((d) => {
            const isToday = sameDay(d, now);
            if (isMobile) {
              return (
                <div key={dateKey(d)} className="flex-1 text-center py-1.5 text-[11px] font-semibold truncate"
                  style={{ color: isToday ? T.danger : T.text }}>
                  {DOW[d.getDay()]} {d.getDate()} {MONTHS[d.getMonth()].slice(0, 3)}
                </div>
              );
            }
            return (
              <div key={dateKey(d)} className="flex-1 text-center pt-1.5">
                <div className="text-[10px] uppercase tracking-wide" style={{ color: T.dim }}>{DOW[d.getDay()]}</div>
                <div className="text-sm font-semibold inline-flex items-center justify-center rounded-full"
                  style={{ width: 26, height: 26, background: isToday ? T.danger : "transparent", color: isToday ? "white" : T.text }}>{d.getDate()}</div>
              </div>
            );
          })}
        </div>
        <div className="flex" style={{ minHeight: 22, paddingRight: gutter }}>
          <div style={{ width: AXIS_W }} className="text-[9px] text-right pr-1.5 pt-0.5"><span style={{ color: T.faint }}>all-day</span></div>
          {days.map((d) => {
            const key = dateKey(d);
            return (
              <div key={key} className="flex-1 px-0.5 pb-1 flex flex-col gap-0.5 border-l overflow-hidden" style={{ borderColor: T.gridLine }}>
                {(allDayByDay[key] || []).map((o) => (
                  <button key={o.renderKey} onClick={() => openEvent(o)} className="rounded px-1.5 text-left text-[10px] font-semibold truncate text-white"
                    style={{ background: ACCENTS[o.ev.color] || ACCENTS.blue, ...(o.ev.suggestion ? { opacity: 0.55, outline: "1.5px dashed rgba(255,255,255,.9)", outlineOffset: -1.5 } : {}) }}><span className="inline-flex items-center gap-1 max-w-full">{o.ev.timeOff ? <Icon name="umbrella" size={9} color="white" sw={2.4} /> : o.ev.holiday ? <Icon name="flag" size={9} color="white" sw={2.4} /> : null}<span className="truncate">{o.ev.title}</span></span></button>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden relative" style={{ overscrollBehavior: "contain" }}>
        <div ref={gridBodyRef} className={`flex relative ${transition ? "rl-fade" : ""}`} style={{ height: 24 * hourH, touchAction: "pan-y" }} onPointerDown={onGridPointerDown}>
          <div style={{ width: AXIS_W }} className="relative flex-shrink-0">
            {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
              <div key={h} className="absolute right-1.5 text-[10px]" style={{ top: h * hourH - 6, color: T.dim }}>{hourH < 40 && h % 2 ? "" : toAmPm(h * 60)}</div>
            ))}
          </div>
          {days.map((d) => {
            const key = dateKey(d);
            const win = unionWindows(key);
            const laid = layoutFor(key);
            return (
              <div key={key} className="flex-1 relative border-l" style={{ borderColor: T.gridLine }}>
                {/* downtime shading first, hour lines painted on top of it */}
                {win ? (
                  <>
                    <div className="absolute left-0 right-0" style={{ top: 0, height: (win.start / 60) * hourH, background: T.shade }} />
                    <div className="absolute left-0 right-0" style={{ top: (win.end / 60) * hourH, bottom: 0, background: T.shade }} />
                  </>
                ) : <div className="absolute inset-0" style={{ background: T.shade }} />}
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} className="absolute left-0 right-0 border-t" style={{ top: h * hourH, borderColor: T.gridLine }} />
                ))}
                <div className="absolute inset-0" onPointerDown={(e) => beginCreate(e, key)} />
                {laid.events.map(({ occ, lay }) => (
                  <EventBlock key={occ.renderKey} occ={occ} lay={lay} hourH={hourH} dragPreview={dragPreview} beginDrag={beginDrag} openEvent={openEvent} openMaps={openMaps} editing={editBlockId === occ.ev.id} />
                ))}
                {laid.tasks.map(({ item, lay }) => (
                  <TaskBlock key={"task_" + item.task.id + (item.done ? "_done" : "")} item={item} lay={lay} hourH={hourH} dragPreview={dragPreview} beginDrag={beginDrag} openTask={openTask} toggleTask={toggleTask} editing={editBlockId === item.task.id} />
                ))}
                {dragPreview && dragPreview.dispDate === key && <GhostBlock preview={dragPreview} hourH={hourH} />}
                {createPreview && createPreview.date === key && (
                  <div className="absolute left-0.5 right-1 rounded-lg pointer-events-none" style={{ top: (createPreview.start / 60) * hourH, height: ((createPreview.end - createPreview.start) / 60) * hourH, background: colorSet("blue", T.mode).bg, border: `1.5px ${createPreview.floating ? "solid" : "dashed"} ${T.accent}`, boxShadow: createPreview.floating ? T.shadow : "none", zIndex: 15 }}>
                    <div className="text-[10px] px-1.5 pt-0.5 font-medium" style={{ color: colorSet("blue", T.mode).text }}>{toAmPm(createPreview.start)} – {toAmPm(createPreview.end)}</div>
                  </div>
                )}
                {/* faint now-line across every day */}
                <div className="absolute left-0 right-0 pointer-events-none" style={{ top: nowTop, height: 1, background: T.danger, opacity: sameDay(d, now) ? 0.9 : 0.18, zIndex: 4 }} />
                {sameDay(d, now) && <div className="absolute rounded-full pointer-events-none" style={{ top: nowTop - 3, left: -3, width: 7, height: 7, background: T.danger, zIndex: 5 }} />}
              </div>
            );
          })}
          {/* current-time pill on the axis */}
          <div className="absolute pointer-events-none flex items-center justify-end" style={{ top: nowTop - 8, left: 0, width: AXIS_W - 3, zIndex: 6 }}>
            <span className="rounded-full text-[9px] font-bold text-white px-1.5" style={{ background: T.danger, lineHeight: "16px" }}>{toAmPm(nowMin)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- month grid ---------- */
function MonthGrid({ anchor, now, allDayByDay, timedByDay, tasksByDay, onOpenDay }) {
  const T = useT();
  const gs = startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gs, i));
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="grid grid-cols-7 border-b" style={{ borderColor: T.border }}>
        {DOW.map((d) => <div key={d} className="text-center text-[10px] uppercase tracking-wide py-1" style={{ color: T.dim }}>{d}</div>)}
      </div>
      <div className="flex-1 grid grid-cols-7 overflow-y-auto" style={{ gridAutoRows: "minmax(84px, 1fr)" }}>
        {cells.map((d) => {
          const key = dateKey(d);
          const inMonth = d.getMonth() === anchor.getMonth();
          const isToday = sameDay(d, now);
          const items = [
            ...(allDayByDay[key] || []).map((o) => ({ kind: "allday", o })),
            ...(timedByDay[key] || []).map((o) => ({ kind: "event", o })),
            ...(tasksByDay[key] || []).map((it) => ({ kind: "task", it })),
          ];
          return (
            <div key={key} className="border-b border-l p-1 cursor-pointer overflow-hidden"
              style={{ borderColor: T.gridLine, background: inMonth ? T.surface : T.shade }} onClick={() => onOpenDay(d)}>
              <div className="text-xs font-medium inline-flex items-center justify-center rounded-full mb-0.5"
                style={{ width: 20, height: 20, background: isToday ? T.danger : "transparent", color: isToday ? "white" : inMonth ? T.text : T.faint }}>{d.getDate()}</div>
              {items.slice(0, 3).map((x, i) => {
                if (x.kind === "allday") return <div key={i} className="rounded px-1 mb-0.5 text-[10px] font-semibold text-white flex items-center gap-1" style={{ background: ACCENTS[x.o.ev.color] || ACCENTS.blue }}>{x.o.ev.timeOff ? <Icon name="umbrella" size={9} color="white" sw={2.4} /> : x.o.ev.holiday ? <Icon name="flag" size={9} color="white" sw={2.4} /> : null}<span className="truncate">{x.o.ev.title}</span></div>;
                if (x.kind === "event") { const c = colorSet(x.o.ev.color, T.mode); return <div key={i} className="truncate rounded px-1 mb-0.5 text-[10px] font-medium" style={{ background: c.bg, color: c.text }}>{x.o.ev.title}</div>; }
                const done = x.it.done;
                const c = done ? colorSet("green", T.mode) : prioSet(x.it.task.priority, T.mode);
                return <div key={i} className={`truncate rounded px-1 mb-0.5 text-[10px] font-medium ${done ? "line-through opacity-60" : ""}`} style={{ background: c.bg, color: c.text }}>{done ? "✓" : "◌"} {x.it.task.title}</div>;
              })}
              {items.length > 3 && <div className="text-[10px]" style={{ color: T.dim }}>+{items.length - 3} more</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- settings row ---------- */
function SettingsRow({ icon, label, right, danger, onClick }) {
  const T = useT();
  return (
    <button onClick={onClick} className="w-full flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium text-left rl-hover"
      style={{ background: T.surface2, color: danger ? T.danger : T.text }}>
      <span className="w-5 flex items-center justify-center" style={{ color: "inherit" }}>{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      <span className="text-xs" style={{ color: T.faint }}>{right ?? "›"}</span>
    </button>
  );
}

/* ---------- stats dashboard ---------- */
function StatsModal({ tasks, events, categories, onClose }) {
  const T = useT();
  const today = new Date();
  const todayKey = dateKey(today);
  const done = tasks.filter((t) => t.done && t.completedAt);

  const counts = {};
  for (const t of done) {
    const k = dateKey(new Date(t.completedAt));
    counts[k] = (counts[k] || 0) + 1;
  }
  const WEEKS = 20;
  const gridStart = startOfWeek(addDays(today, -7 * (WEEKS - 1)));
  const max = Math.max(1, ...Object.values(counts), 1);
  const level = (c) => (c === 0 ? 0 : Math.min(4, Math.ceil((c / max) * 4)));
  const cellBg = (lv) => (lv === 0 ? T.surface2 : `rgba(48,209,88,${[0, 0.3, 0.5, 0.72, 1][lv]})`);

  let last7 = 0;
  for (let i = 0; i < 7; i++) last7 += counts[dateKey(addDays(today, -i))] || 0;
  let streak = 0;
  {
    let i = counts[todayKey] ? 0 : 1;
    while (counts[dateKey(addDays(today, -i))]) { streak++; i++; }
  }
  const pendingCount = tasks.filter((t) => !t.done).length;
  const events30 = useMemo(
    () => expandOccurrences(events, dateKey(addDays(today, -29)), todayKey, deviceTz).filter((o) => !o.ev.timeOff).length,
    [events] // eslint-disable-line
  );

  const byCat = {};
  for (const t of done) {
    const name = categories.find((c) => c.id === t.category)?.name || "Other";
    byCat[name] = (byCat[name] || 0) + 1;
  }
  const catRows = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const maxCat = Math.max(1, ...catRows.map(([, n]) => n));
  const byPrio = { 1: 0, 2: 0, 3: 0 };
  for (const t of done) byPrio[t.priority] = (byPrio[t.priority] || 0) + 1;

  const Tile = ({ label, value }) => (
    <div className="rounded-xl px-3 py-2 flex-1 min-w-0" style={{ background: T.surface2 }}>
      <div className="text-lg font-bold" style={{ color: T.text }}>{value}</div>
      <div className="text-[10px] truncate" style={{ color: T.dim }}>{label}</div>
    </div>
  );

  return (
    <Modal title="Progress" onClose={onClose} wide>
      <div className="flex gap-2 mb-4">
        <Tile label="Tasks done" value={done.length} />
        <Tile label="This week" value={last7} />
        <Tile label="Day streak" value={streak} />
        <Tile label="Pending" value={pendingCount} />
      </div>

      <div className="text-[10px] uppercase tracking-wide mb-1.5" style={{ color: T.dim }}>Completions — last {WEEKS} weeks</div>
      <div className="flex gap-[3px] overflow-x-auto pb-2 mb-1">
        {Array.from({ length: WEEKS }, (_, w) => (
          <div key={w} className="flex flex-col gap-[3px]">
            {Array.from({ length: 7 }, (_, d) => {
              const k = dateKey(addDays(gridStart, w * 7 + d));
              const c = counts[k] || 0;
              const future = k > todayKey;
              return <div key={d} title={`${k} — ${c} done`} style={{ width: 11, height: 11, borderRadius: 2.5, background: future ? "transparent" : cellBg(level(c)) }} />;
            })}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-1.5 mb-4 text-[10px]" style={{ color: T.dim }}>
        less {[0, 1, 2, 3, 4].map((lv) => <span key={lv} style={{ width: 10, height: 10, borderRadius: 2, background: cellBg(lv), display: "inline-block" }} />)} more
        <span className="flex-1" />
        <span>{events30} event{events30 === 1 ? "" : "s"} in the last 30 days</span>
      </div>

      {catRows.length > 0 && (
        <>
          <div className="text-[10px] uppercase tracking-wide mb-1.5" style={{ color: T.dim }}>Done by category</div>
          <div className="flex flex-col gap-1.5 mb-4">
            {catRows.map(([name, n]) => (
              <div key={name} className="flex items-center gap-2">
                <span className="text-xs truncate" style={{ color: T.text, width: 90 }}>{name}</span>
                <div className="flex-1 rounded-full overflow-hidden" style={{ background: T.surface2, height: 8 }}>
                  <div style={{ width: `${(n / maxCat) * 100}%`, height: "100%", background: T.accent, borderRadius: 99 }} />
                </div>
                <span className="text-xs" style={{ color: T.dim, width: 26, textAlign: "right" }}>{n}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="text-[10px] uppercase tracking-wide mb-1.5" style={{ color: T.dim }}>Done by priority</div>
      <div className="flex gap-3">
        {[1, 2, 3].map((p) => {
          const ps = prioSet(p, T.mode);
          return (
            <span key={p} className="inline-flex items-center gap-1.5 text-xs" style={{ color: T.text }}>
              <span className="rounded-full" style={{ width: 8, height: 8, background: ps.dot, display: "inline-block" }} />
              {ps.label}: {byPrio[p] || 0}
            </span>
          );
        })}
      </div>
    </Modal>
  );
}

/* ---------- holidays picker ---------- */
function HolidaysModal({ selected, country, icsCals, onAddIcs, onToggleIcs, onRemoveIcs, icsCache, userCals, onAddUserCal, onToggleUserCal, onRemoveUserCal, onSave, onClose }) {
  const T = useT();
  const [sel, setSel] = useState(selected);
  const [ctry, setCtry] = useState(country);
  const [icsUrl, setIcsUrl] = useState("");
  const [icsName, setIcsName] = useState("");
  const [calName, setCalName] = useState("");
  const toggle = (code) => setSel((s) => (s.includes(code) ? s.filter((x) => x !== code) : [...s, code]));
  const addIcs = () => {
    const url = icsUrl.trim();
    if (!url) return;
    let name = icsName.trim();
    if (!name) { try { name = new URL(url.replace(/^webcal:/i, "https:")).hostname.replace(/^www\./, ""); } catch { name = "Calendar"; } }
    onAddIcs(name, url);
    setIcsUrl(""); setIcsName("");
  };
  const addCal = () => { if (calName.trim()) { onAddUserCal(calName.trim()); setCalName(""); } };
  const CalRow = ({ on, color, name, tag, onToggle, onRemove }) => (
    <div className="flex items-center gap-2 py-1">
      <Check checked={on} onToggle={onToggle} color={ACCENTS[color] || T.accent} />
      <span className="rounded-full flex-shrink-0" style={{ width: 8, height: 8, background: ACCENTS[color] || T.accent }} />
      <span className="flex-1 text-sm truncate" style={{ color: on ? T.text : T.dim }}>{name}</span>
      {tag && <span className="text-[10px]" style={{ color: T.danger }}>{tag}</span>}
      <button onClick={onRemove} className="text-xs px-1" style={{ color: T.faint }} aria-label="Remove">✕</button>
    </div>
  );
  return (
    <Modal title="Calendars" onClose={onClose} wide
      footer={<button onClick={() => onSave(sel, ctry)} className="px-4 py-1.5 rounded-lg text-sm font-semibold text-white" style={{ background: T.accent }}>Save</button>}>
      <div className="text-[10px] uppercase tracking-wide mb-1.5" style={{ color: T.dim }}>My calendars</div>
      {userCals.map((c) => (
        <CalRow key={c.id} on={c.enabled} color={c.color} name={c.name}
          onToggle={() => onToggleUserCal(c.id)} onRemove={() => onRemoveUserCal(c.id)} />
      ))}
      <div className="flex gap-1.5 mb-4 mt-1">
        <input value={calName} onChange={(e) => setCalName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addCal()}
          placeholder="New calendar name" className="flex-1 rounded-lg px-3 py-1.5 text-sm min-w-0" style={inputStyle(T)} />
        <button onClick={addCal} className="rounded-lg text-white font-bold text-sm px-2.5" style={{ background: T.accent }}>＋</button>
      </div>

      <div className="text-[10px] uppercase tracking-wide mb-1.5" style={{ color: T.dim }}>Subscriptions (.ics)</div>
      {icsCals.map((c) => (
        <CalRow key={c.id} on={c.enabled} color={c.color} name={c.name} tag={icsCache[c.id]?.error ? "couldn't load" : null}
          onToggle={() => onToggleIcs(c.id)} onRemove={() => onRemoveIcs(c.id)} />
      ))}
      <div className="flex flex-col gap-1.5 mb-4 mt-1">
        <input value={icsUrl} onChange={(e) => setIcsUrl(e.target.value)}
          placeholder="https://…ics or webcal://…" className="rounded-lg px-3 py-1.5 text-sm" style={inputStyle(T)} />
        <div className="flex gap-1.5">
          <input value={icsName} onChange={(e) => setIcsName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addIcs()}
            placeholder="Name (optional)" className="flex-1 rounded-lg px-3 py-1.5 text-sm min-w-0" style={inputStyle(T)} />
          <button onClick={addIcs} className="rounded-lg text-white font-bold text-sm px-2.5" style={{ background: T.accent }}>＋</button>
        </div>
      </div>

      <div className="text-[10px] uppercase tracking-wide mb-1.5" style={{ color: T.dim }}>Public holidays</div>
      <Row label="Country">
        <select value={ctry} onChange={(e) => setCtry(e.target.value)} className="rounded-md px-2 py-1 text-sm" style={selStyle(T)}>
          {HOLIDAY_CALENDARS.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
        </select>
      </Row>
      <div className="text-[10px] uppercase tracking-wide mt-3 mb-1.5" style={{ color: T.dim }}>Show holidays from</div>
      <div className="grid grid-cols-2 gap-1.5">
        {HOLIDAY_CALENDARS.map((c) => {
          const on = sel.includes(c.code);
          return (
            <button key={c.code} onClick={() => toggle(c.code)} className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-left"
              style={{ background: on ? colorSet(c.color, T.mode).bg : T.surface2, color: on ? colorSet(c.color, T.mode).text : T.dim, border: `1px solid ${on ? colorSet(c.color, T.mode).border : "transparent"}` }}>
              <span className="rounded-full flex-shrink-0" style={{ width: 8, height: 8, background: ACCENTS[c.color] }} />
              <span className="flex-1 truncate">{c.name}</span>
              {on && icsCache[`hol_${c.code}`]?.error && <span className="text-[10px]" style={{ color: T.danger }}>couldn't load</span>}
              {on && <span style={{ color: colorSet(c.color, T.mode).border }}>✓</span>}
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

/* ---------- full-screen item detail (mobile) ---------- */
function DetailPanel({ detail, closing, tasks, events, categories, schedule, waiting, onBack, onEdit, onToggleTask, onToggleEvCheck, onToggleTaskCheck, openMaps }) {
  const T = useT();
  const isTask = detail.type === "task";
  const t = isTask ? tasks.find((x) => x.id === detail.id) : null;
  const ev = !isTask ? (events.find((x) => x.id === detail.id) || detail.snap || null) : null;
  const item = t || ev;
  const panelRef = useRef(null);
  const edgeRef = useRef(null);
  useEffect(() => { if (!item) onBack(); }, [item, onBack]);
  if (!item) return null;

  /* live times for simple events: derive from the event itself (converted
     from its stored tz to this device) — captured detail times only cover
     repeats/midnight splits, where per-occurrence context matters */
  let dDate = detail.occDate, dStart = detail.start, dEnd = detail.end;
  if (!isTask && ev && !ev.allDay && (!ev.repeat || ev.repeat === "none")) {
    const sw = utcToWall(wallToUtc(ev.date, ev.start, ev.tz || deviceTz), deviceTz);
    const ew = utcToWall(wallToUtc(ev.date, ev.end, ev.tz || deviceTz), deviceTz);
    dDate = sw.date; dStart = sw.minutes; dEnd = ew.minutes + (ew.date > sw.date ? 1440 : 0);
  }

  const c = isTask ? prioSet(t.priority, T.mode) : colorSet(ev.color, T.mode);
  const slot = isTask ? schedule[t.id] : null;
  const prereq = isTask && t.dependsOn ? tasks.find((x) => x.id === t.dependsOn) : null;
  const waitItem = isTask && t.waitingOn ? waiting.find((w) => w.id === t.waitingOn) : null;
  const cl = item.checklist || [];
  const dateStr = (k) => `${DOW[dowOfKey(k)]} ${+k.slice(8)} ${MONTHS[+k.slice(5, 7) - 1].slice(0, 3)}`;
  const editable = !ev?.holiday && !ev?.icsCal;

  const InfoRow = ({ icon, children }) => (
    <div className="flex items-start gap-3 py-2">
      <span className="mt-0.5"><Icon name={icon} size={15} color={T.dim} /></span>
      <div className="flex-1 min-w-0 text-sm" style={{ color: T.text }}>{children}</div>
    </div>
  );

  /* notes with tappable links, preserving line breaks */
  const noteParts = (item.notes || "").split(/(https?:\/\/[^\s]+)/g);

  return (
    <div ref={panelRef} className={`fixed inset-0 z-40 flex flex-col ${closing ? "rl-detail-out" : "rl-detail-in"}`}
      onTouchStart={(e) => {
        const t = e.touches[0];
        if (e.touches.length === 1 && t.clientX < 28) edgeRef.current = { x0: t.clientX, y0: t.clientY, on: false };
      }}
      onTouchMove={(e) => {
        const sw = edgeRef.current;
        if (!sw) return;
        const t = e.touches[0];
        const dx = t.clientX - sw.x0, dy = t.clientY - sw.y0;
        if (!sw.on) {
          if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.2) sw.on = true;
          else if (Math.abs(dy) > 16) { edgeRef.current = null; return; }
        }
        if (sw.on && panelRef.current) {
          panelRef.current.style.transition = "none";
          panelRef.current.style.transform = `translateX(${Math.max(0, dx)}px)`;
        }
      }}
      onTouchEnd={() => {
        const sw = edgeRef.current;
        edgeRef.current = null;
        const el = panelRef.current;
        if (!sw || !sw.on || !el) return;
        const dx = parseFloat((el.style.transform.match(/-?[\d.]+/) || [0])[0]) || 0;
        el.style.transition = "transform .18s ease-out";
        if (dx > 70) {
          el.style.animation = "none"; /* suppress the exit keyframes — the swipe IS the exit */
          el.style.transform = "translateX(100%)";
          setTimeout(onBack, 150);
        } else {
          el.style.transform = "";
          setTimeout(() => { if (el) el.style.transition = ""; }, 200);
        }
      }}
      style={{ background: T.bg, paddingTop: "env(safe-area-inset-top)" }}>
      <div className="flex items-center px-2 py-2 border-b" style={{ borderColor: T.border }}>
        <button onClick={onBack} className="flex items-center gap-0.5 px-2 py-1 text-sm font-medium" style={{ color: T.accent }}>
          <Icon name="chevL" size={15} sw={2.4} />Calendar
        </button>
        <div className="flex-1" />
        {editable && <button onClick={onEdit} className="px-3 py-1 text-sm font-medium" style={{ color: T.accent }}>Edit</button>}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4" style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 16px)" }}>
        <div className="flex items-start gap-2.5 mb-3">
          <span className="rounded-full mt-1.5 flex-shrink-0" style={{ width: 12, height: 12, background: c.border }} />
          <h2 className={`text-xl font-bold break-words ${isTask && t.done ? "line-through" : ""}`} style={{ color: T.text }}>{item.title}</h2>
        </div>

        {!isTask && (
          <>
            <InfoRow icon="clock">
              {ev.allDay
                ? `All day · ${dateStr(detail.occDate)}${ev.endDate && ev.endDate !== ev.date ? ` – ${dateStr(ev.endDate)}` : ""}`
                : `${dateStr(dDate)} · ${toAmPm(dStart)} – ${toAmPm(dEnd % 1440)}${ev.tz && ev.tz !== deviceTz ? ` (${tzLabel(ev.tz)})` : ""}`}
              {ev.repeat && ev.repeat !== "none" ? <div style={{ color: T.dim }} className="text-xs mt-0.5">↻ repeats {ev.repeat}{ev.repeatUntil ? ` until ${ev.repeatUntil}` : ""}</div> : null}
            </InfoRow>
            {ev.location && (
              <InfoRow icon="mapPin">
                <button onClick={() => openMaps(ev.location)} className="text-left font-medium" style={{ color: T.accent }}>{ev.location.name}</button>
              </InfoRow>
            )}
            {ev.timeOff && <InfoRow icon="umbrella">Time off — tasks are not scheduled on this day</InfoRow>}
            {ev.holiday && <InfoRow icon="flag">Public holiday (from your holiday calendar)</InfoRow>}
            {ev.icsCal && !ev.holiday && <InfoRow icon="flag">From a subscribed calendar (read-only)</InfoRow>}
          </>
        )}

        {isTask && (
          <>
            <InfoRow icon="clock">
              {slot
                ? `${slot.pinned ? "Fixed time · " : ""}${dateStr(slot.date)} · ${toAmPm(slot.start)} – ${toAmPm(slot.end)}`
                : waitItem && !waitItem.done
                ? `Held — waiting for “${waitItem.title}”`
                : prereq && !prereq.done && !schedule[prereq.id]
                ? `Waiting on “${prereq.title}”`
                : t.done
                ? "Completed"
                : "No slot in the next 4 weeks"}
              <div style={{ color: T.dim }} className="text-xs mt-0.5">
                {t.duration < 60 ? `${t.duration}m` : `${t.duration / 60}h`} · {prioSet(t.priority, T.mode).label} priority · {categories.find((x) => x.id === t.category)?.name || "—"}
                {t.deadline ? ` · due ${t.deadline}` : ""}
              </div>
            </InfoRow>
            {prereq && <InfoRow icon="link">After “{prereq.title}”{prereq.done ? " (done)" : ""}</InfoRow>}
            {waitItem && <InfoRow icon="clock">Waiting for “{waitItem.title}”{waitItem.done ? " (resolved)" : ""}</InfoRow>}
          </>
        )}

        {(item.notes || "").trim() && (
          <div className="rounded-xl px-3.5 py-3 my-3 text-sm whitespace-pre-wrap break-words" style={{ background: T.surface2, color: T.text }}>
            {noteParts.map((part, i) =>
              /^https?:\/\//.test(part)
                ? <a key={i} href={part} target="_blank" rel="noreferrer" className="underline break-all" style={{ color: T.accent }}>{part}</a>
                : part
            )}
          </div>
        )}

        {cl.length > 0 && (
          <div className="my-3">
            <div className="text-[10px] uppercase tracking-wide mb-1.5" style={{ color: T.dim }}>
              Checklist · {cl.filter((x) => x.done).length}/{cl.length}
            </div>
            <div className="flex flex-col gap-2">
              {cl.map((x) => (
                <div key={x.id} className="flex items-center gap-2.5 cursor-pointer"
                  onClick={() => (isTask ? onToggleTaskCheck(item.id, x.id) : onToggleEvCheck(item.id, x.id))}>
                  <Check checked={x.done} onToggle={() => (isTask ? onToggleTaskCheck(item.id, x.id) : onToggleEvCheck(item.id, x.id))} color={T.ok} />
                  <span className={`flex-1 text-sm ${x.done ? "line-through" : ""}`} style={{ color: x.done ? T.faint : T.text }}>{x.text}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {isTask && (
          <button onClick={() => onToggleTask(t.id)}
            className="w-full rounded-xl py-3 mt-4 font-semibold text-white text-sm"
            style={{ background: t.done ? T.dim : T.ok }}>
            {t.done ? "Mark as not done" : "Mark as done"}
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------- year grid (analogue-calendar overview) ---------- */
function YearGrid({ anchor, now, onPickMonth }) {
  const T = useT();
  const y = anchor.getFullYear();
  return (
    <div className="flex-1 overflow-y-auto px-3 py-4">
      <div className="grid grid-cols-3 gap-x-3 gap-y-6 mx-auto" style={{ maxWidth: 780 }}>
        {Array.from({ length: 12 }, (_, m) => {
          const gs = startOfWeek(new Date(y, m, 1));
          const isCur = now.getFullYear() === y && now.getMonth() === m;
          return (
            <button key={m} onClick={() => onPickMonth(m)} className="text-left rounded-xl p-1.5 rl-hover">
              <div className="text-sm font-bold mb-1.5" style={{ color: isCur ? T.danger : T.text }}>{MONTHS[m].slice(0, 3)}</div>
              <div className="grid grid-cols-7 gap-y-1">
                {Array.from({ length: 42 }, (_, i) => {
                  const d = addDays(gs, i);
                  if (d.getMonth() !== m) return <span key={i} />;
                  const t = sameDay(d, now);
                  return (
                    <span key={i} className="text-[9px] text-center rounded-full font-medium"
                      style={{ color: t ? "white" : T.dim, background: t ? T.danger : "transparent", width: 16, height: 16, lineHeight: "16px", justifySelf: "center" }}>
                      {d.getDate()}
                    </span>
                  );
                })}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ==================================================================== */
class ErrorBoundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="app-h flex flex-col items-center justify-center gap-3 p-6" style={{ background: "#000", color: "#eee", fontFamily: "-apple-system, sans-serif" }}>
        <div className="text-sm font-semibold">Something broke.</div>
        <div className="text-xs opacity-70 text-center break-all">{String(this.state.err?.message || this.state.err)}</div>
        <button onClick={() => location.reload()} className="rounded-xl px-4 py-2 text-sm font-semibold" style={{ background: "#333", color: "#fff" }}>Reload</button>
        <div className="text-[10px] opacity-50">Your data is safe in the local mirror and on the server.</div>
      </div>
    );
  }
}

function Planner() {
  const [mode, setMode] = useState(() => { try { return localStorage.getItem("rollover-theme") || "dark"; } catch { return "dark"; } });
  const T = THEMES[mode];
  useEffect(() => { try { localStorage.setItem("rollover-theme", mode); } catch { /* private mode */ } }, [mode]);

  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [events, setEvents] = useState([]);
  const [categories, setCategories] = useState(DEFAULT_CATEGORIES);
  const [waiting, setWaiting] = useState([]);
  const [icsCals, setIcsCals] = useState([]);
  const [userCals, setUserCals] = useState([]);
  const [icsCache, setIcsCache] = useState(() => {
    try { return JSON.parse(localStorage.getItem("rollover-ics-cache-v1")) || {}; } catch { return {}; }
  });
  const [holidayCals, setHolidayCals] = useState([]);
  const [holidayCache, setHolidayCache] = useState({});
  const [country, setCountry] = useState(() => guessCountry());
  const [now, setNow] = useState(new Date());
  const [view, setView] = useState("week");
  const [anchor, setAnchor] = useState(() => {
    /* first paint should have today in the middle of the window, not at the left */
    const vis = typeof window !== "undefined" && window.innerWidth < 640 ? 3 : 7;
    return addDays(new Date(), -Math.floor(vis / 2));
  });
  const [itemDraft, setItemDraft] = useState(null);
  const [showCats, setShowCats] = useState(false);
  const [showHolidays, setShowHolidays] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [showEmail, setShowEmail] = useState(false);
  const [emailInbox, setEmailInbox] = useState(null); /* {address?|unconfigured, suggestions:[]} */
  const [emailErr, setEmailErr] = useState("");
  const [defaultCat, setDefaultCat] = useState("work");
  const [editBlockId, setEditBlockId] = useState(null); /* mobile: block in resize-handle mode */
  const [showSettings, setShowSettings] = useState(false);
  const [ctxMenu, setCtxMenu] = useState(null); /* long-press menu: {type:'event'|'task'|'paste', ...} */
  const clipRef = useRef(null); /* app-internal clipboard for cut/copy/paste */
  const [notifState, setNotifState] = useState("checking"); /* unsupported|off|on|denied|error:<msg> */
  const editBlockIdRef = useRef(null);
  editBlockIdRef.current = editBlockId;
  const [confirmSug, setConfirmSug] = useState(null);
  const [quickTitle, setQuickTitle] = useState("");
  const [newWait, setNewWait] = useState("");
  const [saveState, setSaveState] = useState("idle");
  const [syncErr, setSyncErr] = useState("");
  const [showSyncErr, setShowSyncErr] = useState(false);
  const [idWidgetOpen, setIdWidgetOpen] = useState(false);
  /* Hard rule after the data-loss incident: a device that has NOT completed
     a successful load from the server this session may never push to it.
     Otherwise a device that failed to load (empty state) auto-saves that
     empty state over everyone else's data. */
  const [serverOk, setServerOk] = useState(false);
  const serverOkRef = useRef(false);
  const markServerOk = (v) => { serverOkRef.current = v; setServerOk(v); };
  /* offline-first: edits that haven't reached the server yet survive
     restarts via a persisted flag; the pull loop pushes them when it can */
  const DIRTY_KEY = "planner-dirty-v1";
  const [dirty, setDirty] = useState(() => { try { return !!localStorage.getItem(DIRTY_KEY); } catch { return false; } });
  const markDirty = () => { try { localStorage.setItem(DIRTY_KEY, "1"); } catch { /* quota */ } setDirty(true); };
  const clearDirty = () => { try { localStorage.removeItem(DIRTY_KEY); } catch { /* quota */ } setDirty(false); };
  const hydratedRef = useRef(false);

  useEffect(() => {
    const set = () => {
      const h = window.visualViewport ? Math.round(window.visualViewport.height) : window.innerHeight;
      document.documentElement.style.setProperty("--app-h", `${h}px`);
      if (window.scrollY || window.scrollX) window.scrollTo(0, 0); /* standalone iOS sometimes leaves the document nudged — that IS the black bar */
    };
    set();
    window.addEventListener("focusout", set);
    window.visualViewport?.addEventListener("resize", set);
    window.addEventListener("resize", set);
    window.addEventListener("orientationchange", set);
    return () => {
      window.removeEventListener("focusout", set);
      window.visualViewport?.removeEventListener("resize", set);
      window.removeEventListener("resize", set);
      window.removeEventListener("orientationchange", set);
    };
  }, []);

  /* keep the document background in-theme so nothing black can peek through */
  useEffect(() => {
    document.documentElement.style.background = T.bg;
    document.body.style.background = T.bg;
  }, [T.bg]);
  const lastPushRef = useRef(0);
  const dataRef = useRef(null);
  const editSeqRef = useRef(0); /* bumped on every local edit; stale pulls compare against it */
  const [dragPreview, setDragPreview] = useState(null);
  const [createPreview, setCreatePreview] = useState(null);
  const [hourH, setHourH] = useState(HOUR_H_BASE);
  const [gutter, setGutter] = useState(0);
  const [transition, setTransition] = useState(false);
  const [isMobile, setIsMobile] = useState(() => (typeof window !== "undefined" ? window.innerWidth < 640 : false));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerClosing, setDrawerClosing] = useState(false);
  const closeDrawer = useCallback(() => {
    setDrawerClosing(true);
    setTimeout(() => { setDrawerOpen(false); setDrawerClosing(false); }, 190);
  }, []);
  const zoomAnchor = useRef(null);
  const lastDirRef = useRef(1);
  const wheelAccum = useRef(0);
  const scrollRef = useRef(null);
  const gridBodyRef = useRef(null);
  const saveTimer = useRef(null);
  const dragRef = useRef(null);
  const skipNextSave = useRef(true);
  const gestureRef = useRef(null);
  const hourHRef = useRef(hourH);
  hourHRef.current = hourH;
  const viewRef = useRef("week");

  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30000); return () => clearInterval(t); }, []);
  useEffect(() => { initIdentity((u) => { setUser(u); setAuthReady(true); }, setIdWidgetOpen); }, []);

  /* measure the scrollbar gutter so the all-day header lines up with the grid */
  useEffect(() => {
    const measure = () => {
      const el = scrollRef.current;
      if (el) setGutter(el.offsetWidth - el.clientWidth);
      setIsMobile(window.innerWidth < 640);
    };
    measure();
    window.addEventListener("resize", measure);
    const id = setInterval(measure, 1000);
    return () => { window.removeEventListener("resize", measure); clearInterval(id); };
  }, [loaded, view]);

  /* open instantly from the local mirror; the network reconciles in the
     background. First-ever run (no mirror) falls through to the remote load. */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const m = migrate(JSON.parse(raw));
      setTasks(m.tasks); setEvents(m.events); setCategories(m.categories); setWaiting(m.waiting);
      setHolidayCals(m.holidayCals); setHolidayCache(m.holidayCache); setCountry(m.country); setIcsCals(m.icsCals); setUserCals(m.userCals); setDefaultCat(m.defaultCat);
      hydratedRef.current = true;
      skipNextSave.current = true;
      setLoaded(true);
    } catch { /* corrupt mirror — the remote load below still runs */ }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!authReady) return;
    if (hydratedRef.current) return; /* already open; the pull loop reconciles */
    let alive = true;
    (async () => {
      try {
        const d = await loadData(user);
        if (!alive) return;
        if (user) markServerOk(true);
        if (d) {
          const m = migrate(d);
          setTasks(m.tasks); setEvents(m.events); setCategories(m.categories); setWaiting(m.waiting);
          setHolidayCals(m.holidayCals); setHolidayCache(m.holidayCache); setCountry(m.country); setIcsCals(m.icsCals); setUserCals(m.userCals); setDefaultCat(m.defaultCat);
        } else if (user) {
          const raw = localStorage.getItem(STORE_KEY);
          if (raw) {
            const m = migrate(JSON.parse(raw));
            setTasks(m.tasks); setEvents(m.events); setCategories(m.categories); setWaiting(m.waiting);
            setHolidayCals(m.holidayCals); setHolidayCache(m.holidayCache); setCountry(m.country); setIcsCals(m.icsCals); setUserCals(m.userCals); setDefaultCat(m.defaultCat);
            saveData(user, m).catch(() => {});
          }
        }
      } catch (err) {
        if (user) markServerOk(false);
        setSaveState("error"); setSyncErr(explainSyncError(err));
        /* remote failed — the local mirror still has this device's data */
        try {
          const raw = localStorage.getItem(STORE_KEY);
          if (raw && alive) {
            const m = migrate(JSON.parse(raw));
            setTasks(m.tasks); setEvents(m.events); setCategories(m.categories); setWaiting(m.waiting);
            setHolidayCals(m.holidayCals); setHolidayCache(m.holidayCache); setCountry(m.country); setIcsCals(m.icsCals); setUserCals(m.userCals); setDefaultCat(m.defaultCat);
          }
        } catch { /* corrupt mirror — start empty */ }
      }
      skipNextSave.current = true;
      setLoaded(true);
    })();
    return () => { alive = false; };
  }, [authReady, user]);

  useEffect(() => {
    if (!loaded) return;
    if (skipNextSave.current) { skipNextSave.current = false; return; }
    editSeqRef.current++;
    setSaveState("saving");
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const toServer = !!(user && serverOkRef.current);
      try {
        await saveData(toServer ? user : null, { tasks, events, categories, waiting, holidayCals, holidayCache, country, icsCals, userCals, defaultCat });
        if (toServer) { lastPushRef.current = Date.now(); clearDirty(); }
        else if (user) markDirty(); /* signed in but couldn't push — remember */
        setSaveState("saved");
        setTimeout(() => setSaveState("idle"), 1500);
      } catch (err) {
        if (user) markDirty(); /* mirror is written; the push is what failed */
        setSaveState("error"); setSyncErr(explainSyncError(err));
      }
    }, 500);
    return () => clearTimeout(saveTimer.current);
  }, [tasks, events, categories, waiting, holidayCals, holidayCache, country, icsCals, userCals, defaultCat, loaded, user]);

  /* ---------- periodic pull so all devices stay current ---------- */
  dataRef.current = { tasks, events, categories, waiting, holidayCals, holidayCache, country, icsCals, userCals, defaultCat };
  useEffect(() => {
    if (!user || !loaded) return;
    let busy = false;
    const pull = async () => {
      if (busy || document.hidden) return;
      /* never fight an in-flight local edit: a recent push means this
         device is the source of truth right now */
      if (Date.now() - lastPushRef.current < 5000) return;
      busy = true;
      const seqAtStart = editSeqRef.current;
      try {
        const d = await loadData(user);
        markServerOk(true);
        if (localStorage.getItem(DIRTY_KEY)) {
          /* this device has offline edits — they win; server history keeps
             a snapshot of whatever they replace */
          try {
            await saveData(user, migrate(dataRef.current));
            lastPushRef.current = Date.now();
            clearDirty();
          } catch { /* still offline-ish — next tick retries */ }
          busy = false; return;
        }
        /* a local edit (e.g. a delete) landed while this response was in
           flight — applying the stale server copy would silently undo it */
        if (editSeqRef.current !== seqAtStart) { busy = false; return; }
        if (d) {
          const m = migrate(d);
          if (JSON.stringify(m) !== JSON.stringify(migrate(dataRef.current))) {
            skipNextSave.current = true;
            setTasks(m.tasks); setEvents(m.events); setCategories(m.categories); setWaiting(m.waiting);
            setHolidayCals(m.holidayCals); setHolidayCache(m.holidayCache); setCountry(m.country); setIcsCals(m.icsCals); setUserCals(m.userCals); setDefaultCat(m.defaultCat);
          }
        }
      } catch { /* transient — next tick retries */ }
      busy = false;
    };
    pull(); /* reconcile immediately — the app already opened from the mirror */
    const iv = setInterval(pull, 60000);
    const onWake = () => { if (!document.hidden) pull(); };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    window.addEventListener("online", onWake);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("online", onWake);
    };
  }, [user, loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  const ctxAction = (act) => {
    const m = ctxMenu;
    setCtxMenu(null);
    if (!m) return;
    if (m.type === "paste") {
      const c = clipRef.current;
      if (!c) return;
      if (c.type === "event") {
        const d = c.data;
        const dur = d.allDay ? 0 : Math.max(15, (d.end - d.start) || 60);
        setEvents((es) => [...es, { ...d, id: uid(), srcSugId: undefined, date: m.date, endDate: null,
          start: d.allDay ? 0 : m.minute, end: d.allDay ? 1440 : Math.min(1440, m.minute + dur) }]);
      } else {
        setTasks((ts) => [...ts, { ...c.data, id: uid(), done: false, completedAt: null, createdAt: Date.now(), scheduledAt: { date: m.date, start: m.minute } }]);
      }
      return;
    }
    if (m.type === "event") {
      const ev = events.find((e) => e.id === m.id);
      if (!ev) return;
      if (act === "copy" || act === "cut") clipRef.current = { type: "event", data: { ...ev } };
      if (act === "cut" || act === "delete") { setEvents((es) => es.filter((e) => e.id !== m.id)); setEditBlockId(null); }
      if (act === "duplicate") setEvents((es) => [...es, { ...ev, id: uid(), srcSugId: undefined }]);
    } else {
      const t = tasks.find((x) => x.id === m.id);
      if (!t) return;
      if (act === "copy" || act === "cut") clipRef.current = { type: "task", data: { ...t } };
      if (act === "cut" || act === "delete") { setTasks((ts) => ts.filter((x) => x.id !== m.id)); setEditBlockId(null); }
      if (act === "duplicate") setTasks((ts) => [...ts, { ...t, id: uid(), done: false, completedAt: null, createdAt: Date.now(), scheduledAt: null }]);
    }
  };

  /* ---------- push notifications ---------- */
  const notifSupported = typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  useEffect(() => {
    if (!notifSupported) { setNotifState("unsupported"); return; }
    (async () => {
      try {
        const reg = await navigator.serviceWorker.getRegistration("/sw.js");
        const sub = reg && (await reg.pushManager.getSubscription());
        setNotifState(sub && Notification.permission === "granted" ? "on" : Notification.permission === "denied" ? "denied" : "off");
      } catch { setNotifState("off"); }
    })();
  }, [notifSupported]);

  const enableNotifs = async () => {
    try {
      setNotifState("checking");
      const reg = await navigator.serviceWorker.register("/sw.js");
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { setNotifState(perm === "denied" ? "denied" : "off"); return; }
      const kr = await fetch("/.netlify/functions/notify");
      const kj = await kr.json();
      if (!kj.publicKey) { setNotifState("error:server VAPID keys not configured — see README"); return; }
      const b64 = kj.publicKey.replace(/-/g, "+").replace(/_/g, "/");
      const pad = "=".repeat((4 - (b64.length % 4)) % 4);
      const key = Uint8Array.from(atob(b64 + pad), (c) => c.charCodeAt(0));
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const auth = await getAuthHeader();
      if (!auth) { setNotifState("error:sign in first — notifications need an account"); return; }
      const r = await fetch("/.netlify/functions/notify", {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({ sub: sub.toJSON() }),
      });
      if (!r.ok) throw new Error(`save failed (${r.status})`);
      setNotifState("on");
    } catch (err) { setNotifState(`error:${String(err?.message || err)}`); }
  };
  const disableNotifs = async () => {
    try {
      const reg = await navigator.serviceWorker.getRegistration("/sw.js");
      const sub = reg && (await reg.pushManager.getSubscription());
      if (sub) {
        const auth = await getAuthHeader();
        if (auth) fetch("/.netlify/functions/notify", { method: "DELETE", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
        await sub.unsubscribe();
      }
      setNotifState("off");
    } catch { setNotifState("off"); }
  };

  /* email suggestions: light poll — load, focus, every 5 minutes */
  useEffect(() => {
    if (!user || !loaded) return;
    let dead = false;
    const pull = async () => {
      if (document.hidden) return;
      try {
        const j = await fetchEmailInbox(user);
        if (!dead && j) { setEmailInbox(j); setEmailErr(""); }
      } catch (err) { if (!dead) setEmailErr(String(err?.message || err)); }
    };
    pull();
    const iv = setInterval(pull, 5 * 60e3);
    const onWake = () => { if (!document.hidden) pull(); };
    window.addEventListener("focus", onWake);
    return () => { dead = true; clearInterval(iv); window.removeEventListener("focus", onWake); };
  }, [user, loaded]);

  const acceptSuggestion = async (row) => {
    const p = row.payload;
    const tl = sugLocal(p);
    setEvents((es) => [...es, {
      id: uid(), title: p.title, date: tl.date, endDate: p.endDate || null,
      allDay: !!p.allDay, start: p.allDay ? 0 : tl.start, end: p.allDay ? 1440 : tl.end,
      tz: deviceTz, color: "blue", repeat: "none", repeatUntil: null, exceptions: [],
      location: null, timeOff: false, calId: null, srcSugId: row.id,
      notes: [p.venue, p.details, row.subject ? `From: ${row.subject}` : ""].filter(Boolean).join("\n"),
      checklist: [],
    }]);
    setEmailInbox((m) => (m ? { ...m, suggestions: m.suggestions.filter((x) => x.id !== row.id) } : m));
    try { await actOnSuggestion(user, row.id, "accepted"); } catch { /* re-appears next poll; accept is idempotent-ish */ }
  };
  const dismissSuggestion = async (row) => {
    setEmailInbox((m) => (m ? { ...m, suggestions: m.suggestions.filter((x) => x.id !== row.id) } : m));
    try { await actOnSuggestion(user, row.id, "dismissed"); } catch { /* re-appears next poll */ }
  };

  /* land on the current time; only view changes re-scroll */
  useEffect(() => {
    if (!loaded || view !== "week") return;
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        const m = new Date();
        scrollRef.current.scrollTop = Math.max(0, ((m.getHours() * 60 + m.getMinutes()) / 60) * hourHRef.current - 150);
      }
    });
  }, [view, loaded]);

  /* Netlify Identity renders a full-screen iframe; on notched phones its own
     close button hides under the status bar. Push the iframe below the safe
     area and render our own always-reachable close button. */
  useEffect(() => {
    if (!idWidgetOpen) return;
    const el = document.getElementById("netlify-identity-widget");
    if (el) {
      el.style.setProperty("top", "env(safe-area-inset-top)");
      el.style.setProperty("height", "calc(100% - env(safe-area-inset-top))");
    }
  }, [idWidgetOpen]);

  /* keep the zoom origin (pinch centre / cursor) fixed while the scale changes */
  useLayoutEffect(() => {
    const a = zoomAnchor.current;
    if (a && scrollRef.current) {
      scrollRef.current.scrollTop = Math.max(0, (a.minute / 60) * hourH - a.offsetY);
      zoomAnchor.current = null;
    }
  }, [hourH]);

  const nowMin = now.getHours() * 60 + now.getMinutes();
  const todayKey = dateKey(now);

  const range = useMemo(() => {
    if (view === "month") {
      const gs = startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
      return { start: dateKey(gs), end: dateKey(addDays(gs, 41)) };
    }
    if (view === "week") {
      return { start: dateKey(anchor), end: dateKey(addDays(anchor, isMobile ? 2 : 6)) };
    }
    /* year view draws no items — keep the expansion window trivial */
    return { start: dateKey(anchor), end: dateKey(anchor) };
  }, [view, anchor, isMobile]);

  /* built-in country holidays are implicit ICS subscriptions (Google's
     public holiday feeds -> traditional dates + explicit substitute days) */
  const holidayFeeds = useMemo(() => holidayCals.map((code) => {
    const c = calByCode(code);
    return { id: `hol_${code}`, name: c?.name || code, url: holidayFeedUrl(code), color: c?.color || "red", enabled: true, holiday: true };
  }), [holidayCals]);
  const allFeeds = useMemo(() => [...holidayFeeds, ...icsCals], [holidayFeeds, icsCals]);

  /* subscribed ICS feeds: refresh stale ones (12h), persist the cache locally */
  const icsCacheRef = useRef(icsCache);
  icsCacheRef.current = icsCache;
  useEffect(() => {
    if (!loaded) return;
    let dead = false;
    const sync = async () => {
      for (const cal of allFeeds) {
        if (!cal.enabled || dead) continue;
        const c = icsCacheRef.current[cal.id];
        /* successful fetches are fresh for 12h; FAILED ones only for 10min —
           honoring errors for 12h left devices stuck on poisoned caches */
        const maxAge = c && c.error ? 10 * 60e3 : 12 * 3600e3;
        if (c && Date.now() - (c.fetched || 0) < maxAge) continue;
        try {
          const r = await fetch(`/.netlify/functions/ics?url=${encodeURIComponent(cal.url)}`);
          if (!r.ok) throw new Error(String(r.status));
          const text = await r.text();
          const evs = parseICS(text);
          if (!dead) setIcsCache((m) => ({ ...m, [cal.id]: { fetched: Date.now(), events: evs } }));
        } catch {
          if (!dead) setIcsCache((m) => ({ ...m, [cal.id]: { fetched: Date.now(), events: m[cal.id]?.events || [], error: true } }));
        }
      }
    };
    sync();
    const iv = setInterval(sync, 10 * 60e3);
    return () => { dead = true; clearInterval(iv); };
  }, [allFeeds, loaded]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    try { localStorage.setItem("rollover-ics-cache-v1", JSON.stringify(icsCache)); } catch { /* quota */ }
  }, [icsCache]);

  /* materialise subscribed entries as read-only pseudo events in range;
     FREQ=YEARLY (birthdays) instantiates per year */
  const icsEvents = useMemo(() => {
    const out = [];
    const p2 = (n) => String(n).padStart(2, "0");
    const y0 = +range.start.slice(0, 4), y1 = +range.end.slice(0, 4);
    for (const cal of allFeeds) {
      if (!cal.enabled) continue;
      const c = icsCache[cal.id];
      if (!c || !c.events) continue;
      let entries = c.events;
      if (cal.holiday) {
        /* built-in holiday feeds: hide "(substitute day)"/"(observed)"
           duplicates — but only when the traditional-date entry actually
           exists nearby; if the feed ships ONLY the substitute, keep it
           rather than losing the holiday entirely */
        const subRe = /^(.*) \((?:substitute day|observed)\)$/i;
        entries = c.events.filter((e) => {
          const m = e.title.match(subRe);
          if (!m) return true;
          const base = m[1].trim().toLowerCase();
          return !c.events.some((o) =>
            o !== e && o.title.trim().toLowerCase() === base &&
            o.date <= e.date && o.date >= addDaysKey(e.date, -6));
        });
      }
      for (const e of entries) {
        /* Z-stamped feed times carry the utc instant — place them at the
           viewer's wall clock (parsers no longer bake in an environment tz) */
        let eDate = e.date, eStart = e.start, eEnd = e.end;
        if (!e.allDay && e.startUtcMs != null) {
          const sw = utcToWall(e.startUtcMs, deviceTz);
          eDate = sw.date; eStart = sw.minutes;
          if (e.endUtcMs != null) {
            const ew = utcToWall(e.endUtcMs, deviceTz);
            eEnd = ew.date === sw.date ? Math.max(ew.minutes, sw.minutes + 15) : 1440;
          } else eEnd = Math.min(1440, sw.minutes + Math.max(15, e.end - e.start));
        }
        const mk = (date, endDate, suffix = "") => out.push({
          id: `ics_${cal.id}_${e.uid}${suffix}`, title: e.title, date, endDate,
          allDay: e.allDay, start: eStart, end: eEnd, tz: deviceTz, repeat: "none",
          exceptions: [], location: null, color: cal.color, icsCal: cal.id, holiday: !!cal.holiday, notes: "", checklist: [],
        });
        if (e.yearly) {
          for (let y = y0; y <= y1; y++) {
            if (y < +e.date.slice(0, 4)) continue;
            mk(`${y}-${p2(e.month)}-${p2(e.day)}`, null, `_${y}`);
          }
        } else if (eDate <= range.end && (e.endDate || eDate) >= range.start) {
          mk(eDate, e.endDate);
        }
      }
    }
    return out;
  }, [allFeeds, icsCache, range]);

  /* events on a hidden personal calendar stay out of view (still block scheduling) */
  const disabledCals = useMemo(() => new Set(userCals.filter((c) => !c.enabled).map((c) => c.id)), [userCals]);
  const visibleEvents = useMemo(
    () => (disabledCals.size ? events.filter((e) => !e.calId || !disabledCals.has(e.calId)) : events),
    [events, disabledCals]
  );

  /* a suggestion accepted on any device becomes an event carrying its id;
     once that event arrives with the blob pull, the local copy of the
     suggestion is spent — hide it without waiting for the next email poll */
  const pendingSuggestions = useMemo(() => {
    const realised = new Set(events.map((e) => e.srcSugId).filter((x) => x != null));
    return (emailInbox?.suggestions || []).filter((r) => !realised.has(r.id));
  }, [events, emailInbox]);

  /* pending email suggestions as preliminary blocks — render-only, never
     scheduled around, tap to confirm */
  const suggestionEvents = useMemo(() => pendingSuggestions.map((row) => {
    const p = row.payload;
    const tl = sugLocal(p);
    return {
      id: `sug_${row.id}`, title: p.title, date: tl.date, endDate: p.endDate || null,
      allDay: !!p.allDay, start: p.allDay ? 0 : tl.start, end: p.allDay ? 1440 : tl.end,
      tz: deviceTz, repeat: "none", repeatUntil: null, exceptions: [], location: null,
      color: "gray", suggestion: true, sugId: row.id, notes: "", checklist: [],
    };
  }), [pendingSuggestions]);

  const occurrences = useMemo(() => {
    const evOcc = expandOccurrences(visibleEvents, range.start, range.end, deviceTz);
    const icsOcc = expandOccurrences(icsEvents, range.start, range.end, deviceTz);
    const sugOcc = expandOccurrences(suggestionEvents, range.start, range.end, deviceTz);
    return [...evOcc, ...icsOcc, ...sugOcc];
  }, [visibleEvents, range, icsEvents, suggestionEvents]);
  const schedule = useMemo(() => scheduleTasks(tasks, events, categories, now, deviceTz, waiting), [tasks, events, categories, now, waiting]);

  /* upload the next-48h occurrence times whenever they change — this device's
     scheduler (repeat rules, timezones) does the thinking; the cron just fires */
  useEffect(() => {
    if (!user || notifState !== "on" || !loaded) return;
    const t = setTimeout(async () => {
      try {
        const now = Date.now();
        const items = [];
        for (const o of occurrences) {
          if (o.allDay || o.dispStart == null || o.ev.suggestion || o.ev.holiday || o.ev.timeOff) continue;
          const at = wallToUtc(o.dispDate, o.dispStart, deviceTz);
          if (at > now - 5 * 60e3 && at < now + 48 * 3600e3) items.push({ key: o.renderKey, title: o.ev.title, startUtcMs: at });
        }
        for (const tk of tasks) {
          if (tk.done) continue;
          const slot = schedule[tk.id];
          if (!slot) continue;
          const at = wallToUtc(slot.date, slot.start, deviceTz);
          if (at > now - 5 * 60e3 && at < now + 48 * 3600e3) items.push({ key: `task_${tk.id}_${slot.date}`, title: tk.title, startUtcMs: at });
        }
        const auth = await getAuthHeader();
        if (!auth) return;
        await fetch("/.netlify/functions/notify", {
          method: "POST",
          headers: { Authorization: auth, "Content-Type": "application/json" },
          body: JSON.stringify({ schedule: items }),
        });
      } catch { /* next change retries */ }
    }, 8000);
    return () => clearTimeout(t);
  }, [user, notifState, loaded, occurrences, schedule, tasks]);



  const timedByDay = useMemo(() => {
    const m = {};
    for (const o of occurrences) if (!o.allDay) (m[o.dispDate] ||= []).push(o);
    return m;
  }, [occurrences]);
  const allDayByDay = useMemo(() => {
    const m = {};
    for (const o of occurrences) if (o.allDay) (m[o.dispDate] ||= []).push(o);
    return m;
  }, [occurrences]);
  const tasksByDay = useMemo(() => {
    const m = {};
    for (const t of tasks) {
      if (t.done) {
        if (t.completedSlot) (m[t.completedSlot.date] ||= []).push({ task: t, ...t.completedSlot, done: true });
        continue;
      }
      const s = schedule[t.id];
      if (s) {
        const prereq = t.dependsOn ? tasks.find((x) => x.id === t.dependsOn) : null;
        (m[s.date] ||= []).push({ task: t, ...s, done: false, effPriority: effectivePriority(t, todayKey), chained: !!(prereq && !prereq.done) });
      }
    }
    return m;
  }, [tasks, schedule, todayKey]);

  /* per-day overlap layout, memoised */
  const layoutFor = useCallback((key) => {
    const evs = (timedByDay[key] || []).map((occ) => ({ id: "e_" + occ.renderKey, start: occ.dispStart, end: Math.min(occ.dispEnd, 1440), ref: occ, kind: "event" }));
    const tks = (tasksByDay[key] || []).map((it) => ({ id: "t_" + it.task.id, start: it.start, end: Math.min(it.end, 1440), ref: it, kind: "task" }));
    /* gap under two line-heights -> side-by-side; over -> cascade with capped text */
    const clearance = Math.max(8, Math.round((30 / hourH) * 60));
    const laid = layoutDay([...evs, ...tks], clearance);
    const byId = {};
    for (const l of laid) byId[l.item.id] = l;
    return {
      events: evs.map((e) => ({ occ: e.ref, lay: byId[e.id] })),
      tasks: tks.map((t) => ({ item: t.ref, lay: byId[t.id] })),
    };
  }, [timedByDay, tasksByDay, hourH]);

  /* ---------- mutations ---------- */
  const toggleTask = useCallback((id) => {
    setTasks((ts) => ts.map((t) => {
      if (t.id !== id) return t;
      if (t.done) return { ...t, done: false, completedAt: null, completedSlot: null };
      return { ...t, done: true, completedAt: Date.now(), completedSlot: schedule[t.id] ? { date: schedule[t.id].date, start: schedule[t.id].start, end: schedule[t.id].end } : null };
    }));
  }, [schedule]);
  const deleteTask = (id) => { setTasks((ts) => ts.filter((t) => t.id !== id)); setItemDraft(null); };
  const quickAdd = () => {
    if (!quickTitle.trim()) return;
    setTasks((ts) => [...ts, { id: uid(), title: quickTitle.trim(), duration: 60, deadline: null, priority: 2, category: defaultCat || categories[0]?.id, done: false, createdAt: Date.now(), scheduledAt: null, autoReschedule: true, completedSlot: null }]);
    setQuickTitle("");
  };
  const CAL_COLORS = ["purple", "orange", "green", "blue", "red", "gray"];
  const addIcsCal = (name, url) => setIcsCals((cs) => [...cs, { id: uid(), name, url, color: CAL_COLORS[cs.length % CAL_COLORS.length], enabled: true }]);
  const toggleIcsCal = (id) => setIcsCals((cs) => cs.map((c) => (c.id === id ? { ...c, enabled: !c.enabled } : c)));
  const removeIcsCal = (id) => {
    setIcsCals((cs) => cs.filter((c) => c.id !== id));
    setIcsCache((m) => { const n = { ...m }; delete n[id]; return n; });
  };
  const addUserCal = (name) => setUserCals((cs) => [...cs, { id: uid(), name, color: CAL_COLORS[(cs.length + 3) % CAL_COLORS.length], enabled: true }]);
  const toggleUserCal = (id) => setUserCals((cs) => cs.map((c) => (c.id === id ? { ...c, enabled: !c.enabled } : c)));
  const removeUserCal = (id) => {
    setUserCals((cs) => cs.filter((c) => c.id !== id));
    setEvents((es) => es.map((e) => (e.calId === id ? { ...e, calId: null } : e)));
  };

  const addWait = () => {
    if (!newWait.trim()) return;
    setWaiting((ws) => [...ws, { id: uid(), title: newWait.trim(), done: false, createdAt: Date.now() }]);
    setNewWait("");
  };
  const toggleWait = (id) => setWaiting((ws) => ws.map((w) => (w.id === id ? { ...w, done: !w.done, doneAt: !w.done ? Date.now() : null } : w)));
  const deleteWait = (id) => {
    setWaiting((ws) => ws.filter((w) => w.id !== id));
    setTasks((ts) => ts.map((t) => (t.waitingOn === id ? { ...t, waitingOn: null } : t)));
  };
  const saveTask = (t) => { setTasks((ts) => { const i = ts.findIndex((x) => x.id === t.id); if (i === -1) return [...ts, t]; const c = ts.slice(); c[i] = t; return c; }); setItemDraft(null); };
  const saveEvent = (ev) => { setEvents((es) => { const i = es.findIndex((x) => x.id === ev.id); if (i === -1) return [...es, ev]; const c = es.slice(); c[i] = ev; return c; }); setItemDraft(null); };
  const deleteSeries = (id) => { setEvents((es) => es.filter((e) => e.id !== id)); setItemDraft(null); };
  const deleteOccurrence = (id, occDate) => { setEvents((es) => es.map((e) => (e.id === id ? { ...e, exceptions: [...(e.exceptions || []), occDate] } : e))); setItemDraft(null); };

  const [detail, setDetail] = useState(null);
  const [detailClosing, setDetailClosing] = useState(false);
  const closeDetail = useCallback(() => {
    setDetailClosing(true);
    setTimeout(() => { setDetail(null); setDetailClosing(false); }, 200);
  }, []);

  const openEvent = useCallback((occ) => {
    if (dragRef.current?.moved) return;
    setEditBlockId(null);
    setCtxMenu(null);
    if (occ.ev.suggestion) {
      const row = pendingSuggestions.find((r) => r.id === occ.ev.sugId);
      if (row) setConfirmSug(row);
      return;
    }
    if (isMobile) {
      /* full-screen info panel; holiday/subscribed items are read-only and
         aren't in the events array, so carry a snapshot */
      const ro = occ.ev.holiday || occ.ev.icsCal;
      setDetail({ type: "event", id: occ.ev.id, snap: ro ? occ.ev : null, occDate: occ.occDate, start: occ.dispStart ?? occ.ev.start, end: occ.dispEnd ?? occ.ev.end, allDay: !!occ.allDay });
      return;
    }
    if (occ.ev.holiday || occ.ev.icsCal) return; /* read-only */
    setItemDraft({ ...occ.ev, itemType: occ.ev.timeOff ? "timeoff" : "event", occDate: occ.occDate });
  }, [isMobile, pendingSuggestions]);
  const openTask = useCallback((t) => {
    if (dragRef.current?.moved) return;
    if (isMobile) { setDetail({ type: "task", id: t.id }); return; }
    setItemDraft({ ...t, itemType: "task" });
  }, [isMobile]);

  /* write-through checklist toggles for the detail panel */
  const toggleEvCheck = useCallback((evId, cid) => setEvents((es) => es.map((e) => (e.id === evId ? { ...e, checklist: (e.checklist || []).map((c) => (c.id === cid ? { ...c, done: !c.done } : c)) } : e))), []);
  const toggleTaskCheck = useCallback((tId, cid) => setTasks((ts) => ts.map((t) => (t.id === tId ? { ...t, checklist: (t.checklist || []).map((c) => (c.id === cid ? { ...c, done: !c.done } : c)) } : t))), []);
  const openMaps = useCallback((loc) => window.open(`https://www.google.com/maps/search/?api=1&query=${loc.lat},${loc.lon}`, "_blank"), []);

  /* view switch with a short cross-fade/scale */
  const changeView = useCallback((v) => {
    setView((cur) => {
      if (v === cur) return cur;
      setTransition(true);
      setTimeout(() => setTransition(false), 260);
      return v;
    });
  }, []);

  viewRef.current = view;
  const visibleN = isMobile ? 3 : 7;
  const anchorKeyRef = useRef(dateKey(anchor));
  anchorKeyRef.current = dateKey(anchor);
  const visNRef = useRef(visibleN);
  visNRef.current = visibleN;
  const days = useMemo(() => {
    if (view !== "week") return [];
    return Array.from({ length: visibleN }, (_, i) => addDays(anchor, i));
  }, [view, anchor, visibleN]);

  const shift = useCallback((dir) => {
    lastDirRef.current = dir;
    setAnchor((a) => {
      if (view === "year") { const d = new Date(a); d.setFullYear(d.getFullYear() + dir); return d; }
      if (view === "month") { const d = new Date(a); d.setMonth(d.getMonth() + dir); return d; }
      return addDays(a, dir * (isMobile ? 3 : 7));
    });
  }, [view, isMobile]);

  /* Scroll blocker for the floating-create gesture. Tracked in one ref with
     one removal function so it can never leak; the blocker also self-disarms
     (checks a live floating create) so even a missed removal can't kill
     scrolling. */
  const touchBlockRef = useRef(null);
  const clearTouchBlock = useCallback(() => {
    if (touchBlockRef.current) {
      window.removeEventListener("touchmove", touchBlockRef.current);
      touchBlockRef.current = null;
    }
  }, []);
  const armTouchBlock = useCallback(() => {
    clearTouchBlock();
    const fn = (te) => { if (dragRef.current && dragRef.current.floating) te.preventDefault(); };
    touchBlockRef.current = fn;
    window.addEventListener("touchmove", fn, { passive: false });
  }, [clearTouchBlock]);

  /* one day at a time — used by side-scroll/swipe so days snap along */
  const stepDay = useCallback((dir) => {
    lastDirRef.current = dir;
    setAnchor((a) => {
      if (view === "month") { const d = new Date(a); d.setMonth(d.getMonth() + dir); return d; }
      return addDays(a, dir);
    });
  }, [view]);

  /* ---------- drag / resize existing blocks ---------- */
  const beginDrag = useCallback((e, target, mode) => {
    if (e.button !== undefined && e.button !== 0) return;
    if (target.type === "event" && (target.occ.ev.suggestion || target.occ.ev.icsCal || target.occ.ev.holiday)) return;
    e.stopPropagation();
    const isTouch = e.pointerType === "touch";
    const disp = target.type === "event"
      ? { date: target.occ.dispDate, start: target.occ.dispStart, end: target.occ.dispEnd }
      : { date: target.item.date, start: target.item.start, end: target.item.end };
    const meta = target.type === "event"
      ? { title: target.occ.ev.title, colorName: target.occ.ev.color, dashed: false }
      : { title: target.item.task.title, colorName: PRIORITY[target.item.task.priority]?.c || "blue", dashed: true };
    const targetId = target.type === "event" ? target.occ.ev.id : target.item.task.id;
    const editingThis = editBlockIdRef.current === targetId;
    /* mobile: blocks never move from a plain press — long-press enters edit
       mode (ring + handles); only then do press-and-drag / handle-drags act */
    const st = { target, mode, disp, meta, x0: e.clientX, y0: e.clientY, active: !isTouch || mode !== "move" || editingThis, moved: false, dayDelta: 0, minDelta: 0, timer: null };
    if (isTouch && mode === "move" && !editingThis) st.timer = setTimeout(() => {
      setEditBlockId(targetId);
      setCtxMenu({ type: target.type, id: targetId, x: st.x0, y: st.y0 });
      if (navigator.vibrate) navigator.vibrate(15);
      st.editArmed = true; /* rest of this gesture is consumed: no drag, and no click on release */
    }, 400);
    dragRef.current = st;

    const move = (ev) => {
      const s = dragRef.current;
      if (!s) return;
      const dx = ev.clientX - s.x0, dy = ev.clientY - s.y0;
      if (s.editArmed) return; /* long-press already consumed this gesture */
      if (!s.active) { if (Math.hypot(dx, dy) > 10) { clearTimeout(s.timer); s.moved = true; cleanup(); } return; }
      ev.preventDefault();
      if (Math.hypot(dx, dy) > 5) s.moved = true;
      if (!s.moved) return;
      s.minDelta = Math.round(dy / (hourHRef.current / 60) / 15) * 15;
      if (s.mode === "move" && gridBodyRef.current && days.length > 1) {
        const colW = (gridBodyRef.current.getBoundingClientRect().width - 52) / days.length;
        s.dayDelta = Math.round(dx / colW);
      } else s.dayDelta = 0;
      const dur = s.disp.end - s.disp.start;
      let p;
      if (s.mode === "move") {
        const start = Math.min(Math.max(s.disp.start + s.minDelta, 0), 1440 - Math.min(dur, 1440));
        p = { dispDate: addDaysKey(s.disp.date, s.dayDelta), dispStart: start, dispEnd: start + dur };
      } else if (s.mode === "resize-end") {
        p = { dispDate: s.disp.date, dispStart: s.disp.start, dispEnd: Math.max(s.disp.start + 15, s.disp.end + s.minDelta) };
      } else {
        p = { dispDate: s.disp.date, dispStart: Math.min(s.disp.end - 15, Math.max(0, s.disp.start + s.minDelta)), dispEnd: s.disp.end };
      }
      s.preview = p;
      setDragPreview({ key: s.target.type === "event" ? s.target.occ.renderKey : "task_" + s.target.item.task.id, ...p, title: s.meta.title, cset: colorSet(s.meta.colorName, mode), dashed: s.meta.dashed });
    };
    const up = () => {
      const s = dragRef.current;
      if (s) {
        clearTimeout(s.timer);
        if (s.editArmed) s.moved = true; /* release after long-press: block the click */
        else if (s.active && s.moved && s.preview) commitDrag(s);
      }
      cleanup();
    };
    const cleanup = () => {
      const wasMoved = dragRef.current?.moved;
      setDragPreview(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      /* keep .moved visible to the click handler that fires right after pointerup */
      setTimeout(() => { dragRef.current = null; }, wasMoved ? 80 : 0);
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }, [days, mode]);

  const commitDrag = (s) => {
    const { target, mode: m, dayDelta, minDelta, preview } = s;
    if (target.type === "event") {
      const occ = target.occ;
      setEvents((es) => es.map((ev) => {
        if (ev.id !== occ.ev.id) return ev;
        let startUtc = occ.startUtc, endUtc = occ.endUtc;
        if (m === "move") { const d = (dayDelta * 1440 + minDelta) * 60000; startUtc += d; endUtc += d; }
        else if (m === "resize-end") endUtc = Math.max(startUtc + 15 * 60000, endUtc + minDelta * 60000);
        else startUtc = Math.min(endUtc - 15 * 60000, startUtc + minDelta * 60000);
        const w = utcToWall(startUtc, ev.tz);
        const dur = Math.round((endUtc - startUtc) / 60000);
        if (!ev.repeat || ev.repeat === "none") return { ...ev, date: w.date, start: w.minutes, end: w.minutes + dur };
        const shift = diffDaysKey(w.date, occ.occDate);
        return { ...ev, date: addDaysKey(ev.date, shift), start: w.minutes, end: w.minutes + dur };
      }));
    } else {
      const id = target.item.task.id;
      setTasks((ts) => ts.map((t) => {
        if (t.id !== id) return t;
        if (m === "move") return { ...t, scheduledAt: { date: preview.dispDate, start: preview.dispStart } };
        /* resize: duration changes; pin start if it was pinned or resize-start moved it */
        const dur = preview.dispEnd - preview.dispStart;
        const pin = t.scheduledAt || m === "resize-start" ? { date: preview.dispDate, start: preview.dispStart } : t.scheduledAt;
        return { ...t, duration: dur, scheduledAt: pin };
      }));
    }
  };

  /* ---------- drag on empty grid to create ---------- */
  const beginCreate = useCallback((e, key) => {
    if (e.button !== undefined && e.button !== 0) return;
    if (dragRef.current) return;
    if (gestureRef.current && gestureRef.current.pts.size >= 1) return; /* a touch gesture owns this */
    const isTouch = e.pointerType === "touch";
    const rect = e.currentTarget.getBoundingClientRect();
    const yToMin = (clientY) => Math.max(0, Math.min(1440, Math.round(((clientY - rect.top) / hourHRef.current) * 60 / 15) * 15));
    const anchorMin = yToMin(e.clientY);
    const st = { create: true, key, anchorMin, x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY, active: !isTouch, moved: false, timer: null, last: anchorMin, edgeTimer: null };

    /* geometry of the whole grid so a floating touch block can cross days */
    const grid = gridBodyRef.current ? gridBodyRef.current.getBoundingClientRect() : rect;
    const colW = () => (grid.width - AXIS_W) / visNRef.current;
    const placeFloating = (x, y) => {
      const col = Math.min(visNRef.current - 1, Math.max(0, Math.floor((x - grid.left - AXIS_W) / colW())));
      const date = addDaysKey(anchorKeyRef.current, col);
      let start = Math.round((((y - grid.top) / hourHRef.current) * 60 - 30) / 15) * 15;
      start = Math.max(0, Math.min(1380, start));
      st.pv = { date, start, end: start + 60 };
      setCreatePreview({ ...st.pv, floating: true });
    };
    const setEdge = (dir) => {
      if (st.edgeDir === dir) return;
      clearInterval(st.edgeTimer);
      st.edgeDir = dir;
      if (dir) {
        st.edgeTimer = setInterval(() => {
          stepDay(dir);
          /* re-place under the (possibly stationary) finger once the window rolls */
          requestAnimationFrame(() => placeFloating(st.lx, st.ly));
        }, 480);
      }
    };

    if (isTouch) {
      /* iOS-style: hold to spawn a 1-hour block under the finger, then drag
         it anywhere — holding at the left/right edge rolls to other days */
      st.timer = setTimeout(() => {
        if (dragRef.current !== st) return; /* gesture was cancelled (e.g. a pinch started) */
        if (clipRef.current) {
          /* something on the clipboard: offer paste-here instead of create */
          setCtxMenu({ type: "paste", x: st.lx, y: st.ly, date: key, minute: yToMin(st.ly) });
          if (navigator.vibrate) navigator.vibrate(15);
          st.moved = true; /* the release's click is spent — cleanup keeps .moved visible for it */
          return;
        }
        st.active = true;
        st.floating = true;
        if (navigator.vibrate) navigator.vibrate(15);
        /* stop the browser claiming the gesture for scrolling — a claimed
           gesture fires pointercancel, which used to pop the editor early */
        armTouchBlock();
        placeFloating(st.lx, st.ly);
      }, 500);
    }
    dragRef.current = st;

    const move = (ev) => {
      const s = dragRef.current;
      if (!s || !s.create) return;
      s.lx = ev.clientX; s.ly = ev.clientY;
      const dx = ev.clientX - s.x0, dy = ev.clientY - s.y0;
      if (!s.active) { if (Math.hypot(dx, dy) > 14) { clearTimeout(s.timer); cleanup(); } return; }
      ev.preventDefault();
      if (s.floating) {
        placeFloating(ev.clientX, ev.clientY);
        const EDGE = 28;
        if (ev.clientX < grid.left + AXIS_W + EDGE) setEdge(-1);
        else if (ev.clientX > grid.right - EDGE) setEdge(1);
        else setEdge(0);
        return;
      }
      /* mouse: paint a time range in the pressed column */
      if (Math.abs(dy) > 6) s.moved = true;
      if (!s.moved) return;
      s.last = yToMin(ev.clientY);
      const a = Math.min(s.anchorMin, s.last), b = Math.max(s.anchorMin, s.last);
      setCreatePreview({ date: key, start: a, end: Math.max(b, a + 15) });
    };
    const up = () => {
      const s = dragRef.current;
      if (s && s.create) {
        clearTimeout(s.timer);
        clearInterval(s.edgeTimer);
        if (s.active) {
          if (s.floating && s.pv) {
            setItemDraft({ itemType: "event", fromGrid: true, ...s.pv, color: "blue", tz: deviceTz });
          } else if (s.moved) {
            const a = Math.min(s.anchorMin, s.last), b = Math.max(s.anchorMin, s.last);
            setItemDraft({ itemType: "event", fromGrid: true, date: key, start: a, end: Math.max(b, a + 15), color: "blue", tz: deviceTz });
          } else if (!isTouch) {
            const m = Math.floor(s.anchorMin / 30) * 30;
            setItemDraft({ itemType: "event", fromGrid: true, date: key, start: m, end: Math.min(m + 60, 1440), color: "blue", tz: deviceTz });
          }
        }
      }
      cleanup();
    };
    const cleanup = () => {
      const cur = dragRef.current;
      if (cur) clearInterval(cur.edgeTimer);
      clearTouchBlock();
      dragRef.current = null;
      setCreatePreview(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", abort);
    };
    const abort = () => cleanup();
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", abort);
  }, [stepDay, armTouchBlock, clearTouchBlock]);

  const offDays = useMemo(() => {
    const set = new Set();
    for (const o of occurrences) if (o.allDay && o.ev.timeOff) set.add(o.dispDate);
    return set;
  }, [occurrences]);
  const unionWindows = useCallback((key) => {
    if (offDays.has(key)) return null;
    const wins = categories.map((c) => windowFor(c, key)).filter(Boolean);
    if (!wins.length) return null;
    return { start: Math.min(...wins.map((w) => w.start)), end: Math.max(...wins.map((w) => w.end)) };
  }, [categories, offDays]);

  /* ---------- multitouch: pinch to zoom (vertical, anchored at the pinch
     centre) / switch view (horizontal), plus horizontal swipe that snaps
     day-by-day as the finger keeps moving ---------- */
  const resetGesture = useCallback(() => {
    const g = gestureRef.current;
    if (!g) return;
    window.removeEventListener("pointermove", g.move);
    window.removeEventListener("pointerup", g.up);
    window.removeEventListener("pointercancel", g.up);
    const el = gridBodyRef.current;
    if (el) { el.style.transform = ""; el.style.transformOrigin = ""; }
    gestureRef.current = null;
  }, []);

  /* iOS occasionally swallows a pointerup, leaving a ghost finger in the map
     forever — after that, every one-finger touch "is" a pinch and long-press
     create dies. TouchEvent.touches is ground truth for how many fingers are
     really down, so reconcile against it and drop the oldest (= ghost) extras. */
  useEffect(() => {
    const sync = (e) => {
      const g = gestureRef.current;
      if (!g) return;
      if (e.touches.length === 0) { resetGesture(); return; }
      while (g.pts.size > e.touches.length) {
        const oldest = g.pts.keys().next().value;
        g.pts.delete(oldest);
      }
      if (g.pts.size < 2 && g.pinching) {
        /* the "pinch" was ghost-driven — abandon it, don't commit its zoom */
        g.pinching = false;
        g.lastR = null;
        const el = gridBodyRef.current;
        if (el) { el.style.transform = ""; el.style.transformOrigin = ""; }
      }
    };
    window.addEventListener("touchstart", sync, { passive: true });
    window.addEventListener("touchend", sync, { passive: true });
    window.addEventListener("touchcancel", sync, { passive: true });
    return () => {
      window.removeEventListener("touchstart", sync);
      window.removeEventListener("touchend", sync);
      window.removeEventListener("touchcancel", sync);
    };
  }, [resetGesture]);

  const onGridPointerDown = useCallback((e) => {
    if (e.pointerType !== "touch") return;
    let g = gestureRef.current;
    if (!g) {
      g = gestureRef.current = { pts: new Map() };
      g.move = (ev) => {
        const pt = g.pts.get(ev.pointerId);
        if (!pt) return;
        pt.x = ev.clientX; pt.y = ev.clientY; pt.t = performance.now();

        if (g.pinching && g.pts.size === 2) {
          ev.preventDefault();
          const [a, b] = [...g.pts.values()];
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          /* live zoom is a pure compositor transform — no React re-render per
             frame, so it tracks the fingers at 60fps; the real layout commits
             once on release. Sub-linear response keeps it from feeling twitchy. */
          let r = Math.pow(dist / g.startDist, 0.65);
          r = Math.min(HOUR_H_MAX / g.startHourH, Math.max(HOUR_H_MIN / g.startHourH, r));
          g.lastR = r;
          const el = gridBodyRef.current;
          if (el && g.anchorContentY != null) {
            el.style.transformOrigin = `0px ${g.anchorContentY}px`;
            el.style.transform = `scaleY(${r})`;
          }
        } else if (g.pts.size === 1 && !g.pinching) {
          if (dragRef.current && dragRef.current.active) return; /* a block drag / floating create owns this finger */
          const dx = ev.clientX - g.swipeX0, dy = ev.clientY - g.swipeY0;
          if (!g.swipeAxis && (Math.abs(dx) > 24 || Math.abs(dy) > 24)) g.swipeAxis = Math.abs(dx) > Math.abs(dy) * 1.4 ? "h" : "v";
          if (g.swipeAxis === "h") {
            ev.preventDefault();
            const STEP = 60; /* px of horizontal travel per day */
            if (Math.abs(dx) >= STEP) {
              stepDay(dx < 0 ? 1 : -1); /* swipe left -> forward */
              g.swipeX0 = ev.clientX;   /* re-arm so a long drag keeps snapping day-by-day */
            }
          }
        }
      };
      g.up = (ev) => {
        g.pts.delete(ev.pointerId);
        if (g.swipeAxis === "h" && g.pts.size === 0 && !dragRef.current) {
          /* iOS can fire a click at the swipe's end position — over whatever
             block happens to be there; borrow the drag tombstone to eat it */
          dragRef.current = { moved: true };
          setTimeout(() => { if (dragRef.current && !dragRef.current.target) dragRef.current = null; }, 250);
        }
        if (g.pts.size < 2 && g.pinching) {
          g.pinching = false;
          const el = gridBodyRef.current;
          if (el) { el.style.transform = ""; el.style.transformOrigin = ""; }
          if (g.lastR != null) {
            const newH = Math.round(Math.min(HOUR_H_MAX, Math.max(HOUR_H_MIN, g.startHourH * g.lastR)));
            zoomAnchor.current = { minute: (g.anchorContentY / g.startHourH) * 60, offsetY: g.anchorOffsetY };
            setHourH(newH);
            g.lastR = null;
          }
        }
        if (g.pts.size === 0) resetGesture();
      };
      window.addEventListener("pointermove", g.move, { passive: false });
      window.addEventListener("pointerup", g.up);
      window.addEventListener("pointercancel", g.up);
    }

    /* a pointer that hasn't reported anything in 8s is a ghost — expire it */
    const now = performance.now();
    for (const [id, p] of g.pts) if (now - (p.t || 0) > 8000) g.pts.delete(id);
    g.pts.set(e.pointerId, { x: e.clientX, y: e.clientY, t: now });

    if (g.pts.size === 2) {
      const [a, b] = [...g.pts.values()];
      g.startDist = Math.max(20, Math.hypot(a.x - b.x, a.y - b.y));
      g.startHourH = hourHRef.current;
      g.pinching = true;
      g.lastR = null;
      /* remember which content point sits under the pinch centre so zoom keeps it fixed */
      if (scrollRef.current) {
        const rect = scrollRef.current.getBoundingClientRect();
        const centerY = (a.y + b.y) / 2 - rect.top;
        g.anchorContentY = scrollRef.current.scrollTop + centerY;
        g.anchorOffsetY = centerY;
      }
      if (dragRef.current) {
        clearInterval(dragRef.current.edgeTimer);
        clearTimeout(dragRef.current.timer); /* pending long-press must die too, or it spawns a ghost block mid-pinch */
        dragRef.current = null;
        clearTouchBlock();
        setCreatePreview(null);
        setDragPreview(null);
      } /* cancel single-finger drag/create */
    } else if (g.pts.size === 1) {
      g.swipeX0 = e.clientX; g.swipeY0 = e.clientY; g.swipeAxis = null;
      setEditBlockId(null); /* tapping the grid dismisses resize handles */
      setCtxMenu(null);
    }
  }, [stepDay, clearTouchBlock, resetGesture]);

  /* desktop wheel: ctrl/cmd+scroll zooms (anchored at the cursor),
     plain horizontal scroll (trackpad / shift+wheel) pages the days along */
  const onGridWheel = useCallback((e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      if (scrollRef.current) {
        const rect = scrollRef.current.getBoundingClientRect();
        const offsetY = e.clientY - rect.top;
        const h = hourHRef.current;
        zoomAnchor.current = { minute: ((scrollRef.current.scrollTop + offsetY) / h) * 60, offsetY };
      }
      setHourH((h) => Math.round(Math.min(HOUR_H_MAX, Math.max(HOUR_H_MIN, h * (e.deltaY < 0 ? 1.07 : 0.93)))));
      return;
    }
    const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0;
    if (!dx) return;
    e.preventDefault();
    wheelAccum.current += dx;
    if (Math.abs(wheelAccum.current) >= 90) {
      stepDay(wheelAccum.current > 0 ? 1 : -1);
      wheelAccum.current = 0;
    }
  }, [stepDay]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("wheel", onGridWheel, { passive: false });
    return () => el.removeEventListener("wheel", onGridWheel);
  }, [onGridWheel, loaded, view]);

  /* slide animation when the anchor moves — applied via classList before
     paint, never via className, so the transition flag flipping off can't
     re-trigger it (that replay was the brief rightward "lag") */
  const viewWrapRef = useRef(null);
  const firstAnchor = useRef(true);
  useLayoutEffect(() => {
    if (firstAnchor.current) { firstAnchor.current = false; return; }
    const el = view === "week" ? gridBodyRef.current : viewWrapRef.current;
    if (!el) return;
    const cls = lastDirRef.current > 0 ? "rl-slide-l" : "rl-slide-r";
    el.classList.remove("rl-slide-l", "rl-slide-r");
    void el.offsetWidth; /* restart the animation */
    el.classList.add(cls);
    const t = setTimeout(() => el.classList.remove(cls), 240);
    return () => clearTimeout(t);
  }, [anchor]); // eslint-disable-line react-hooks/exhaustive-deps


  /* the header label doubles as the "zoom out" control:
     week -> month -> year, each showing where a tap takes you */
  /* put a chosen day in the middle of the rolling window, not at the left */
  const centerOn = (d) => addDays(d, -Math.floor(visibleN / 2));

  const backLabel = view === "week"
    ? `${MONTHS[anchor.getMonth()].slice(0, 3)} ${anchor.getFullYear()}`
    : `${anchor.getFullYear()}`;

  const pendingTasks = tasks.filter((t) => !t.done).sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
  const [showAllDone, setShowAllDone] = useState(false);
  const weekAgo = Date.now() - 7 * 86400e3;
  const doneAll = tasks.filter((t) => t.done).sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
  const doneTasks = showAllDone ? doneAll : doneAll.filter((t) => (t.completedAt || 0) > weekAgo);
  const olderDone = doneAll.length - doneAll.filter((t) => (t.completedAt || 0) > weekAgo).length;
  const catName = (id) => categories.find((c) => c.id === id)?.name || "—";

  if (!loaded) {
    return (
      <ThemeCtx.Provider value={T}>
        <div className="app-h flex items-center justify-center text-sm" style={{ color: T.dim, background: T.bg, fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }}>Loading Rollover…</div>
      </ThemeCtx.Provider>
    );
  }

  return (
    <ThemeCtx.Provider value={T}>
      <style>{`.rl-hover:hover{background:${T.hover}} button{cursor:pointer} button:disabled{cursor:not-allowed} select,input[type=date]{cursor:pointer} a{cursor:pointer} html{color-scheme:${mode}} ::-webkit-scrollbar{width:10px;height:10px} ::-webkit-scrollbar-thumb{background:${T.mode === "dark" ? "#3a3a3e" : "#c9c9ce"};border-radius:5px;border:2px solid ${T.surface}} ::-webkit-scrollbar-track{background:transparent} @keyframes rlFade{0%{opacity:0;transform:scale(0.985)}100%{opacity:1;transform:scale(1)}} .rl-fade{animation:rlFade 0.26s cubic-bezier(0.22,0.61,0.36,1)} @keyframes rlSlideL{0%{opacity:0.5;transform:translateX(26px)}100%{opacity:1;transform:none}} @keyframes rlSlideR{0%{opacity:0.5;transform:translateX(-26px)}100%{opacity:1;transform:none}} .rl-slide-l{animation:rlSlideL 0.22s ease-out} .rl-slide-r{animation:rlSlideR 0.22s ease-out} @media (prefers-reduced-motion: reduce){.rl-slide-l,.rl-slide-r{animation:none}} @media (max-width:640px){input,select,textarea{font-size:16px !important}} @keyframes rlSheet{0%{transform:translateY(48px);opacity:0.55}100%{transform:none;opacity:1}} .rl-sheet{animation:rlSheet 0.24s cubic-bezier(0.22,0.61,0.36,1)} @keyframes rlDetailIn{0%{transform:translateX(100%)}100%{transform:none}} @keyframes rlDetailOut{0%{transform:none}100%{transform:translateX(100%)}} .rl-detail-in{animation:rlDetailIn 0.22s cubic-bezier(0.22,0.61,0.36,1)} .rl-detail-out{animation:rlDetailOut 0.19s ease-in forwards} @keyframes rlDrawerIn{0%{transform:translateX(-100%)}100%{transform:none}} @keyframes rlDrawerOut{0%{transform:none}100%{transform:translateX(-100%)}} .rl-drawer-in{animation:rlDrawerIn 0.22s cubic-bezier(0.22,0.61,0.36,1)} .rl-drawer-out{animation:rlDrawerOut 0.19s ease-in forwards} @keyframes rlFadeBg{0%{opacity:0}100%{opacity:1}} .rl-fadebg{animation:rlFadeBg 0.22s ease-out} .rl-fadebg-out{animation:rlFadeBg 0.19s ease-in reverse forwards} @media (prefers-reduced-motion: reduce){.rl-sheet{animation:none}} *{-webkit-touch-callout:none} input,textarea{-webkit-user-select:text;user-select:text} @media (prefers-reduced-motion: reduce){.rl-fade{animation:none}}`}</style>
      <div className="app-h flex select-none" style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", background: T.bg, color: T.text, colorScheme: mode, paddingTop: "env(safe-area-inset-top)" }}>
        {/* ---------- sidebar (drawer on mobile) ---------- */}
        {isMobile && drawerOpen && <div className={`fixed inset-0 z-30 ${drawerClosing ? "rl-fadebg-out" : "rl-fadebg"}`} style={{ background: "rgba(0,0,0,0.45)" }} onClick={closeDrawer} />}
        {(!isMobile || drawerOpen) && (
        <div className={isMobile ? `fixed inset-y-0 left-0 z-40 w-72 flex flex-col border-r ${drawerClosing ? "rl-drawer-out" : "rl-drawer-in"}` : "w-72 flex-shrink-0 flex flex-col border-r"}
          style={{ borderColor: T.border, background: T.surface, boxShadow: isMobile ? T.shadow : "none", paddingTop: isMobile ? "env(safe-area-inset-top)" : 0 }}>
          <div className="px-4 pt-4 pb-2 flex items-center justify-between">
            <h2 className="font-bold text-lg flex items-center gap-1.5" style={{ color: T.text }}>
              <span aria-hidden="true" style={{ color: T.accent }}>↻</span>Rollover
            </h2>
            <button className="text-[10px] text-left" style={{ color: saveState === "error" ? T.danger : T.faint, cursor: saveState === "error" ? "pointer" : "default" }}
              title={saveState === "error" ? syncErr : ""} onClick={() => { if (saveState === "error" && syncErr) setShowSyncErr((v) => !v); }}>
              {saveState === "saving" ? (user ? "syncing…" : "saving…") : saveState === "saved" ? (user ? (serverOk ? "synced" : "saved offline — will sync") : "saved") : saveState === "error" ? "sync failed — tap for details" : user && dirty ? "unsynced changes — will sync" : ""}
            </button>
            {showSyncErr && saveState === "error" && (
              <div className="text-[10px] mt-0.5 max-w-[190px]" style={{ color: T.danger }}>{syncErr}</div>
            )}
          </div>

          <div className="px-4 pb-3 flex gap-1.5">
            <input value={quickTitle} onChange={(e) => setQuickTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && quickAdd()}
              placeholder="Quick task — Enter to add" className="flex-1 rounded-lg px-3 py-2 text-sm min-w-0" style={inputStyle(T)} />
            <button onClick={() => setItemDraft({ itemType: "task", title: quickTitle, category: defaultCat })} title="New task with details"
              className="rounded-lg text-white font-bold text-sm px-3" style={{ background: T.accent }}>＋</button>
          </div>

          <div className="flex-1 overflow-y-auto px-2">
            {pendingTasks.length === 0 && <p className="text-xs text-center mt-6 px-4" style={{ color: T.dim }}>No tasks yet. Quick-add above, or tap ＋ to set a time, priority, and category.</p>}
            {pendingTasks.map((t) => {
              const slot = schedule[t.id];
              const p = prioSet(t.priority, T.mode);
              const prereq = t.dependsOn ? tasks.find((x) => x.id === t.dependsOn) : null;
              const prereqPending = prereq && !prereq.done;
              const waitItem = t.waitingOn ? waiting.find((w) => w.id === t.waitingOn) : null;
              const held = waitItem && !waitItem.done;
              const cl = t.checklist || [];
              const overdue = slot && ((t.deadline && slot.date > t.deadline) || (slot.pinned && (slot.date < dateKey(now) || (slot.date === dateKey(now) && slot.end <= nowMin))));
              return (
                <div key={t.id} className="group flex items-start gap-2 px-2 py-2 rounded-lg rl-hover cursor-pointer" onClick={() => openTask(t)}>
                  <div className="mt-0.5"><Check checked={false} onToggle={() => toggleTask(t.id)} color={p.dot} /></div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate flex items-center gap-1.5" style={{ color: T.text }}>
                      <span className="rounded-full flex-shrink-0" style={{ width: 6, height: 6, background: p.dot }} />{t.title}
                    </div>
                    <div className="text-[11px]" style={{ color: overdue ? T.danger : T.dim }}>
                      {slot ? `${slot.pinned ? "pinned · " : ""}${sameDay(parseKey(slot.date), now) ? "Today" : `${DOW[dowOfKey(slot.date)]} ${+slot.date.slice(8)}`} · ${toAmPm(slot.start)}` : held ? `Held — waiting for “${waitItem.title}”` : prereqPending && !schedule[prereq.id] ? `Waiting on “${prereq.title}”` : "No slot in next 4 weeks"}
                      {" · "}{t.duration < 60 ? `${t.duration}m` : `${t.duration / 60}h`} · {catName(t.category)}{slot && prereqPending ? ` · after ${prereq.title}` : ""}{cl.length ? ` · ${cl.filter((c) => c.done).length}/${cl.length}` : ""}{overdue ? " · overdue" : ""}
                    </div>
                  </div>
                  <button onClick={(e) => { e.stopPropagation(); deleteTask(t.id); }} className="opacity-0 group-hover:opacity-100 text-xs px-1" style={{ color: T.faint }} aria-label="Delete task">✕</button>
                </div>
              );
            })}
            {pendingSuggestions.length > 0 && (
              <>
                <div className="flex items-center gap-1.5 px-2 mt-3 mb-1">
                  <Icon name="mail" size={11} color={T.dim} />
                  <span className="text-[10px] uppercase tracking-wide flex-1" style={{ color: T.dim }}>From email</span>
                </div>
                {pendingSuggestions.map((row) => {
                  const p = row.payload;
                  const tl = sugLocal(p);
                  return (
                    <div key={row.id} className="mx-2 mb-1.5 rounded-xl px-2.5 py-2" style={{ background: T.surface2 }}>
                      <div className="text-sm font-medium truncate" style={{ color: T.text }}>{p.title}</div>
                      <div className="text-[11px] truncate" style={{ color: T.dim }}>
                        {tl.date}{p.endDate ? ` – ${p.endDate}` : ""}{p.allDay ? " · all day" : ` · ${toAmPm(tl.start)}`}{p.venue ? ` · ${p.venue}` : ""}
                      </div>
                      <div className="flex gap-1.5 mt-1.5">
                        <button onClick={() => acceptSuggestion(row)} className="flex-1 rounded-lg py-1 text-xs font-semibold text-white" style={{ background: T.ok }}>Add</button>
                        <button onClick={() => dismissSuggestion(row)} className="rounded-lg px-2.5 py-1 text-xs font-medium" style={{ background: T.surface, color: T.dim }}>✕</button>
                      </div>
                    </div>
                  );
                })}
              </>
            )}
            <div className="flex items-center gap-1.5 px-2 mt-3 mb-1">
              <Icon name="clock" size={11} color={T.dim} />
              <span className="text-[10px] uppercase tracking-wide flex-1" style={{ color: T.dim }}>Waiting on</span>
            </div>
            <div className="flex gap-1.5 px-2 mb-1">
              <input value={newWait} onChange={(e) => setNewWait(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addWait()}
                placeholder="e.g. Reply from Dave…" className="flex-1 rounded-lg px-2.5 py-1.5 text-xs min-w-0" style={inputStyle(T)} />
              <button onClick={addWait} className="rounded-lg text-white font-bold text-xs px-2" style={{ background: T.accent }}>＋</button>
            </div>
            {waiting.map((w) => {
              const holds = tasks.filter((t) => !t.done && t.waitingOn === w.id);
              return (
                <div key={w.id} className="group flex items-start gap-2 px-2 py-1.5 rounded-lg rl-hover">
                  <div className="mt-0.5"><Check checked={!!w.done} onToggle={() => toggleWait(w.id)} color={ACCENTS.orange} /></div>
                  <div className="flex-1 min-w-0">
                    <div className={`text-sm truncate ${w.done ? "line-through" : ""}`} style={{ color: w.done ? T.faint : T.text }}>{w.title}</div>
                    {holds.length > 0 && (
                      <div className="text-[11px] truncate" style={{ color: w.done ? T.faint : colorSet("orange", T.mode).text }}>
                        holding {holds.length}: {holds.map((t) => t.title).join(", ")}
                      </div>
                    )}
                  </div>
                  <button onClick={() => deleteWait(w.id)} className="opacity-0 group-hover:opacity-100 text-xs px-1" style={{ color: T.faint }} aria-label="Delete">✕</button>
                </div>
              );
            })}

            {doneTasks.length > 0 && (
              <>
                <div className="flex items-center px-2 mt-3 mb-1">
                  <span className="text-[10px] uppercase tracking-wide flex-1" style={{ color: T.dim }}>Completed{showAllDone ? "" : " · 7 days"}</span>
                  {olderDone > 0 && (
                    <button onClick={() => setShowAllDone((v) => !v)} className="text-[10px]" style={{ color: T.accent }}>
                      {showAllDone ? "recent only" : `show ${olderDone} older`}
                    </button>
                  )}
                </div>
                {doneTasks.slice(0, 20).map((t) => (
                  <div key={t.id} className="group flex items-center gap-2 px-2 py-1.5 rounded-lg rl-hover">
                    <Check checked onToggle={() => toggleTask(t.id)} color={T.ok} />
                    <div className="flex-1 text-sm truncate line-through" style={{ color: T.faint }}>{t.title}</div>
                    <button onClick={() => deleteTask(t.id)} className="opacity-0 group-hover:opacity-100 text-xs px-1" style={{ color: T.faint }} aria-label="Delete task">✕</button>
                  </div>
                ))}
              </>
            )}
          </div>

          <div className="px-3 py-3 border-t flex flex-col gap-1.5" style={{ borderColor: T.border }}>
            <SettingsRow icon={<Icon name="sliders" size={15} />} label="Hours & categories" onClick={() => setShowCats(true)} />
            <SettingsRow icon={<Icon name="flag" size={15} />} label="Calendars" right="›" onClick={() => setShowHolidays(true)} />
            <SettingsRow icon={<Icon name="gear" size={15} />} label="Settings" right="›" onClick={() => setShowSettings(true)} />
            {isMobile && <SettingsRow icon={<Icon name={mode === "dark" ? "sun" : "moon"} size={15} />} label={mode === "dark" ? "Light mode" : "Dark mode"} onClick={() => setMode(mode === "dark" ? "light" : "dark")} />}
            {user && (
              <SettingsRow icon={<Icon name="mail" size={15} />} label="Email import" right={emailInbox?.unconfigured ? "setup" : "›"} onClick={() => setShowEmail(true)} />
            )}
            {user ? (
              <SettingsRow icon={<Icon name="user" size={15} />} label={user.email} right="Sign out" danger onClick={doLogout} />
            ) : (
              <SettingsRow icon={<Icon name="user" size={15} />} label="Sign in to sync across devices" onClick={openLogin} />
            )}
          </div>
        </div>
        )}

        {/* ---------- calendar ---------- */}
        <div className="flex-1 flex flex-col min-w-0" style={{ background: T.surface }}>
          <div className={`flex items-center border-b ${isMobile ? "gap-1 px-2 py-2" : "gap-2 px-4 py-2.5"}`} style={{ borderColor: T.border }}>
            {isMobile && (
              <button onClick={() => setDrawerOpen(true)} className="relative rounded-lg px-2 py-1.5 text-sm" style={{ background: T.surface2, color: T.text }} aria-label="Open tasks">
                <Icon name="menu" size={16} />{pendingTasks.length > 0 && <span className="absolute -top-1 -right-1 rounded-full text-[9px] font-bold text-white flex items-center justify-center" style={{ background: T.danger, minWidth: 15, height: 15, padding: "0 3px" }}>{pendingTasks.length}</span>}
              </button>
            )}
            {view === "year" ? (
              <h1 className={`font-bold px-1 ${isMobile ? "text-base" : "text-lg"}`} style={{ color: T.text }}>{anchor.getFullYear()}</h1>
            ) : (
              <button onClick={() => changeView(view === "week" ? "month" : "year")}
                aria-label={view === "week" ? "Switch to month view" : "Switch to year view"}
                className={`flex items-center gap-0.5 rounded-lg px-1.5 py-1 font-bold rl-hover ${isMobile ? "text-base" : "text-lg"}`}
                style={{ color: T.accent }}>
                <Icon name="chevL" size={14} sw={2.6} />{backLabel}
              </button>
            )}
            {view === "month" && (
              <span className={`font-bold px-0.5 ${isMobile ? "text-base" : "text-lg"}`} style={{ color: T.text }}>
                {MONTHS[anchor.getMonth()]}
              </span>
            )}
            <div className="flex-1" />
            <button onClick={() => setShowStats(true)} className="px-2 py-1 rounded-md" style={{ color: T.dim }} title="Progress" aria-label="Progress stats"><Icon name="chart" size={15} /></button>
            {!isMobile && <button onClick={() => setMode(mode === "dark" ? "light" : "dark")} className="px-2 py-1 text-sm rounded-md" style={{ color: T.dim }} title="Toggle dark mode" aria-label="Toggle dark mode">{mode === "dark" ? <Icon name="sun" size={15} /> : <Icon name="moon" size={15} />}</button>}
            {!isMobile && <button onClick={() => { lastDirRef.current = -1; shift(-1); }} className="px-2 py-1 text-sm" style={{ color: T.accent }} aria-label="Previous">‹</button>}
            <button onClick={() => { lastDirRef.current = 1; setAnchor(view === "week" ? centerOn(new Date()) : new Date()); }} className="px-2.5 py-1 text-xs font-medium" style={{ color: T.accent }}>Today</button>
            {!isMobile && <button onClick={() => { lastDirRef.current = 1; shift(1); }} className="px-2 py-1 text-sm" style={{ color: T.accent }} aria-label="Next">›</button>}
            <button onClick={() => setItemDraft({ itemType: "event", date: dateKey(anchor), start: Math.min(Math.ceil(nowMin / 30) * 30, 23 * 60), end: Math.min(Math.ceil(nowMin / 30) * 30 + 60, 1440), color: "blue", tz: deviceTz })}
              className={`ml-1 rounded-lg text-white font-semibold text-xs ${isMobile ? "px-2.5 py-1.5" : "px-3 py-1.5"}`} style={{ background: T.accent }}>{isMobile ? "＋" : "＋ New"}</button>
          </div>

          {isMobile && view === "week" && (
            <WeekStrip anchor={anchor} now={now} visibleN={visibleN}
              onPickDay={(d) => { lastDirRef.current = d >= anchor ? 1 : -1; setAnchor(centerOn(d)); }}
              onSwipeWeek={(dir) => { lastDirRef.current = dir; setAnchor((a) => addDays(a, dir * 7)); }} />
          )}
          {view === "year" ? (
            <div key={anchor.getFullYear()} ref={viewWrapRef} className={`flex-1 flex flex-col min-h-0 ${transition ? "rl-fade" : ""}`}>
              <YearGrid anchor={anchor} now={now}
                onPickMonth={(m) => { setAnchor(new Date(anchor.getFullYear(), m, 1)); changeView("month"); }} />
            </div>
          ) : view === "month" ? (
            <div key={`${anchor.getFullYear()}-${anchor.getMonth()}`} ref={viewWrapRef} className={`flex-1 flex flex-col min-h-0 ${transition ? "rl-fade" : ""}`}
              onPointerDown={onGridPointerDown} style={{ touchAction: "pan-y" }}>
              <MonthGrid anchor={anchor} now={now} allDayByDay={allDayByDay} timedByDay={timedByDay} tasksByDay={tasksByDay}
                onOpenDay={(d) => { setAnchor(centerOn(d)); changeView("week"); }} />
            </div>
          ) : (
            <TimeGrid days={days} now={now} nowMin={nowMin} hourH={hourH} isMobile={isMobile} allDayByDay={allDayByDay} timedByDay={timedByDay} tasksByDay={tasksByDay} editBlockId={editBlockId}
              layoutFor={layoutFor} unionWindows={unionWindows} scrollRef={scrollRef} gridBodyRef={gridBodyRef} gutter={gutter}
              dragPreview={dragPreview} createPreview={createPreview} beginDrag={beginDrag} beginCreate={beginCreate} onGridPointerDown={onGridPointerDown}
              openEvent={openEvent} openTask={openTask} toggleTask={toggleTask} openMaps={openMaps} transition={transition} />
          )}
        </div>

        {itemDraft && (
          <ItemModal draft={itemDraft} events={events} tasks={tasks} waiting={waiting} userCals={userCals} categories={categories}
            onSaveEvent={saveEvent} onSaveTask={saveTask}
            onDeleteSeries={deleteSeries} onDeleteOccurrence={deleteOccurrence} onDeleteTask={deleteTask}
            onClose={() => setItemDraft(null)} />
        )}
        {showCats && <CategoriesModal categories={categories} defaultCat={defaultCat} onSave={(cs, dc) => { setCategories(cs); if (dc) setDefaultCat(dc); setShowCats(false); }} onClose={() => setShowCats(false)} />}
        {detail && (
          <DetailPanel detail={detail} closing={detailClosing} tasks={tasks} events={events} categories={categories}
            schedule={schedule} waiting={waiting} onBack={closeDetail}
            onEdit={() => {
              if (detail.type === "task") {
                const t = tasks.find((x) => x.id === detail.id);
                if (t) setItemDraft({ ...t, itemType: "task" });
              } else {
                const ev = events.find((x) => x.id === detail.id);
                if (ev) setItemDraft({ ...ev, itemType: ev.timeOff ? "timeoff" : "event", occDate: detail.occDate });
              }
            }}
            onToggleTask={toggleTask} onToggleEvCheck={toggleEvCheck} onToggleTaskCheck={toggleTaskCheck} openMaps={openMaps} />
        )}
        {showSettings && (
          <Modal title="Settings" onClose={() => setShowSettings(false)}>
            <div className="text-[10px] uppercase tracking-wide mb-1.5" style={{ color: T.dim }}>Tasks</div>
            <label className="flex items-center justify-between gap-2 text-sm mb-4" style={{ color: T.text }}>
              Default category for new tasks
              <select value={categories.some((c) => c.id === defaultCat) ? defaultCat : categories[0]?.id}
                onChange={(e) => setDefaultCat(e.target.value)}
                className="rounded-lg px-2 py-1.5 text-sm" style={{ background: T.surface2, color: T.text, border: "none" }}>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <div className="text-[10px] uppercase tracking-wide mb-1.5" style={{ color: T.dim }}>Notifications</div>
            {notifState === "unsupported" ? (
              <p className="text-xs" style={{ color: T.dim }}>This browser doesn't support push notifications. On iPhone, add Rollover to your Home Screen (iOS 16.4+) and enable from inside the installed app.</p>
            ) : notifState === "denied" ? (
              <p className="text-xs" style={{ color: T.dim }}>Notifications are blocked for this site — re-allow them in your browser/system settings, then try again.</p>
            ) : notifState.startsWith("error:") ? (
              <p className="text-xs" style={{ color: T.danger }}>{notifState.slice(6)}</p>
            ) : (
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs flex-1" style={{ color: T.dim }}>
                  {notifState === "on" ? "On — you'll get a push an hour before and when things start." : "Get a push an hour before and when tasks or events start."}
                </p>
                {notifState === "on"
                  ? <button onClick={disableNotifs} className="rounded-lg px-3 py-1.5 text-xs font-medium" style={{ background: T.surface2, color: T.dim }}>Turn off</button>
                  : <button onClick={enableNotifs} disabled={notifState === "checking"} className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white" style={{ background: T.accent }}>{notifState === "checking" ? "…" : "Enable"}</button>}
              </div>
            )}
            {notifState === "on" && <NotifDiagnostics />}
            {!user && notifState !== "unsupported" && <p className="text-[10px] mt-1.5" style={{ color: T.faint }}>Notifications need a signed-in account (the server sends them).</p>}
          </Modal>
        )}
        {ctxMenu && (
          <div className="fixed z-[65] flex items-center gap-0.5 rounded-2xl px-1 py-1"
            style={{ left: Math.max(8, Math.min(window.innerWidth - 232, ctxMenu.x - 110)), top: Math.max(8, ctxMenu.y - 64), background: T.surface, boxShadow: T.shadow, border: `1px solid ${T.border}` }}>
            {ctxMenu.type === "paste" ? (
              <>
                <button onClick={() => ctxAction("paste")} className="px-3 py-1.5 rounded-xl text-sm font-semibold" style={{ color: T.accent }}>Paste</button>
                <button onClick={() => { const m = ctxMenu; setCtxMenu(null); setItemDraft({ itemType: "event", date: m.date, start: m.minute, end: Math.min(1440, m.minute + 60) }); }} className="px-3 py-1.5 rounded-xl text-sm" style={{ color: T.text }}>New event</button>
              </>
            ) : (
              <>
                <button onClick={() => ctxAction("cut")} className="px-2.5 py-1.5 rounded-xl text-sm" style={{ color: T.text }}>Cut</button>
                <button onClick={() => ctxAction("copy")} className="px-2.5 py-1.5 rounded-xl text-sm" style={{ color: T.text }}>Copy</button>
                <button onClick={() => ctxAction("duplicate")} className="px-2.5 py-1.5 rounded-xl text-sm" style={{ color: T.text }}>Duplicate</button>
                <button onClick={() => ctxAction("delete")} className="px-2.5 py-1.5 rounded-xl text-sm font-semibold" style={{ color: T.danger }}>Delete</button>
              </>
            )}
          </div>
        )}
        {confirmSug && (() => {
          const p = confirmSug.payload;
          const tl = sugLocal(p);
          return (
            <div className="fixed inset-0 z-[70] flex items-center justify-center p-6" style={{ background: "rgba(0,0,0,.45)" }} onClick={() => setConfirmSug(null)}>
              <div className="rounded-2xl p-4 w-full max-w-xs" style={{ background: T.surface, boxShadow: T.shadow }} onClick={(e) => e.stopPropagation()}>
                <div className="text-sm font-bold mb-1" style={{ color: T.text }}>Add to calendar?</div>
                <div className="text-sm font-medium" style={{ color: T.text }}>{p.title}</div>
                <div className="text-[11px] mb-3" style={{ color: T.dim }}>{tl.date}{p.endDate ? ` – ${p.endDate}` : ""}{p.allDay ? " · all day" : ` · ${toAmPm(tl.start)} – ${toAmPm(tl.end % 1440)}`}</div>
                <div className="flex gap-2">
                  <button className="flex-1 rounded-xl py-2 text-sm font-medium" style={{ background: T.surface2, color: T.dim }} onClick={() => setConfirmSug(null)}>Not now</button>
                  <button className="flex-1 rounded-xl py-2 text-sm font-semibold text-white" style={{ background: T.ok }} onClick={() => { acceptSuggestion(confirmSug); setConfirmSug(null); }}>Add</button>
                </div>
              </div>
            </div>
          );
        })()}
        {showEmail && (
          <Modal title="Email import" onClose={() => setShowEmail(false)}>
            {emailInbox?.address ? (
              <>
                <p className="text-xs mb-2" style={{ color: T.dim }}>
                  Forward booking confirmations — flights, hotels, reservations, appointments — to your private address and they'll appear as suggestions. An auto-forward filter for your usual senders works too.
                </p>
                <button className="w-full rounded-xl px-3 py-2.5 text-sm font-mono break-all text-left" style={{ background: T.surface2, color: T.text }}
                  onClick={() => { try { navigator.clipboard.writeText(emailInbox.address); } catch { /* clipboard unavailable */ } }}>
                  {emailInbox.address}
                </button>
                <p className="text-[10px] mt-1.5" style={{ color: T.faint }}>Tap to copy. Only emails sent to this exact address are read.</p>
              </>
            ) : emailInbox?.unconfigured ? (
              <p className="text-xs" style={{ color: T.dim }}>
                The server reports missing environment variable{emailInbox.missing?.length > 1 ? "s" : ""}:{" "}
                <span className="font-mono" style={{ color: T.danger }}>{(emailInbox.missing || []).join(", ")}</span>
                {" "}in the <span className="font-mono">{emailInbox.context}</span> deploy context. Check the variable exists for the context this URL is served from (production vs deploy-preview vs branch), then redeploy.
              </p>
            ) : emailErr ? (
              <p className="text-xs" style={{ color: T.danger }}>
                Couldn't reach the email function: {emailErr}. A 404 means the deployed build predates this feature; anything else is in the function logs.
              </p>
            ) : (
              <p className="text-xs" style={{ color: T.dim }}>Checking the server…</p>
            )}
          </Modal>
        )}
        {showStats && <StatsModal tasks={tasks} events={events} categories={categories} onClose={() => setShowStats(false)} />}
        {showHolidays && <HolidaysModal icsCals={icsCals} onAddIcs={addIcsCal} onToggleIcs={toggleIcsCal} onRemoveIcs={removeIcsCal} icsCache={icsCache}
          userCals={userCals} onAddUserCal={addUserCal} onToggleUserCal={toggleUserCal} onRemoveUserCal={removeUserCal} selected={holidayCals} country={country} onSave={(sel, c) => {
            setHolidayCals(sel); setCountry(c); setShowHolidays(false);
            setIcsCache((m) => { const n = { ...m }; for (const k of Object.keys(n)) if (n[k]?.error) delete n[k]; return n; });
          }} onClose={() => setShowHolidays(false)} />}
      </div>
    </ThemeCtx.Provider>
  );
}

export default function App() {
  return <ErrorBoundary><Planner /></ErrorBoundary>;
}
