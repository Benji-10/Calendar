import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback, useContext, createContext } from "react";
import tzlookup from "tz-lookup";
import {
  toAmPm, MONTHS, DOW, deviceTz,
  dateKey, parseKey, addDays, startOfWeek, sameDay,
  addDaysKey, dowOfKey, diffDaysKey,
  wallToUtc, utcToWall, timeZoneList, tzLabel,
} from "./time.js";
import { expandOccurrences, scheduleTasks, windowFor, layoutDay, effectivePriority } from "./scheduler.js";
import { initIdentity, openLogin, doLogout, loadData, saveData, STORE_KEY } from "./storage.js";
import { HOLIDAY_CALENDARS, calByCode, guessCountry, fetchHolidays, yearsForRange } from "./holidays.js";

const HOUR_H_BASE = 48;
const HOUR_H_MIN = 30;
const HOUR_H_MAX = 84;
const AXIS_W = 56;
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

/* map sync failures to what the person can actually do about them */
function explainSyncError(err) {
  const m = String(err?.message || err);
  if (m.includes("404")) return "Sync endpoint not found (404). Serverless functions aren't deployed — Netlify Drop only ships static files, so use a Git-connected deploy (or `netlify deploy`) for accounts to work.";
  if (m.includes("500")) return "Server error (500). Most likely DATABASE_URL isn't set: Netlify → Site configuration → Environment variables → add DATABASE_URL with your Neon connection string, then redeploy.";
  if (m.includes("401")) return "Not authorised (401). Sign out and back in; if it persists, check Identity is enabled in Netlify (Site configuration → Identity).";
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
  out.tasks = out.tasks.map((t) => ({ category: "work", scheduledAt: null, autoReschedule: true, completedSlot: null, ...t }));
  out.events = out.events.map((e) => ({ tz: deviceTz, repeat: "none", allDay: false, endDate: null, exceptions: [], location: null, ...e }));
  out.holidayCals = d.holidayCals || [];
  out.holidayCache = d.holidayCache || {};
  out.country = d.country || guessCountry();
  return out;
}

/* ---------- atoms ---------- */
function TimeSelect({ value, onChange, from = 0, to = 1440, step = 15, disabled }) {
  const T = useT();
  const opts = [];
  for (let m = from; m <= to; m += step) opts.push(m);
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
function ItemModal({ draft, events, categories, onSaveEvent, onSaveTask, onDeleteSeries, onDeleteOccurrence, onDeleteTask, onClose }) {
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
      });
    } else {
      onSaveTask({
        done: false, createdAt: Date.now(), completedSlot: null, ...draft,
        id: draft.id || uid(), title: title.trim(),
        duration, priority, category, deadline: deadline || null,
        scheduledAt: pickTime ? { date: taskDate, start: taskStart } : null,
        autoReschedule,
      });
    }
  };

  const seg = (t, label) => (
    <button onClick={() => setItemType(t)} className="flex-1 py-1.5 text-xs font-semibold rounded-lg transition-colors"
      style={{ background: itemType === t ? T.accent : "transparent", color: itemType === t ? "white" : T.dim }}>{label}</button>
  );

  return (
    <Modal title={isNew ? (itemType === "event" ? "New Event" : "New Task") : (itemType === "event" ? "Edit Event" : "Edit Task")} onClose={onClose}
      footer={
        <>
          {!isNew && itemType === "event" && repeat !== "none" && draft.occDate && (
            <button onClick={() => onDeleteOccurrence(draft.id, draft.occDate)} className="px-2 py-1.5 text-xs font-medium" style={{ color: T.danger }}>Delete this day</button>
          )}
          {!isNew && itemType === "event" && (
            <button onClick={() => onDeleteSeries(draft.id)} className="px-2 py-1.5 text-xs font-medium" style={{ color: T.danger }}>{repeat !== "none" ? "Delete series" : "Delete"}</button>
          )}
          {!isNew && itemType === "task" && (
            <button onClick={() => onDeleteTask(draft.id)} className="px-2 py-1.5 text-xs font-medium" style={{ color: T.danger }}>Delete</button>
          )}
          <div className="flex-1" />
          <button onClick={commit} className="px-4 py-1.5 rounded-lg text-sm font-semibold text-white" style={{ background: T.accent }}>{isNew ? "Add" : "Save"}</button>
        </>
      }>
      <div className="flex flex-col gap-3">
        {isNew && (
          <div className="flex rounded-xl p-0.5" style={{ background: T.surface2 }}>
            {seg("event", "Event")}{seg("task", "Task")}
          </div>
        )}

        <div className="relative">
          <input autoFocus value={title}
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

        {itemType === "event" ? (
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
                      className="flex-1 truncate text-sm font-medium" style={{ color: T.accent }} title="Open in Google Maps">📍 {location.name}</a>
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
      </div>
    </Modal>
  );
}

/* ---------- categories / hours editor ---------- */
function CategoriesModal({ categories, onSave, onClose }) {
  const T = useT();
  const [cats, setCats] = useState(() => JSON.parse(JSON.stringify(categories)));
  const [sel, setSel] = useState(cats[0]?.id);
  const [ovDate, setOvDate] = useState("");
  const [ovOff, setOvOff] = useState(true);
  const [ovStart, setOvStart] = useState(540);
  const [ovEnd, setOvEnd] = useState(1140);
  const cat = cats.find((c) => c.id === sel);
  const patch = (fn) => setCats((cs) => cs.map((c) => (c.id === sel ? fn(JSON.parse(JSON.stringify(c))) : c)));

  return (
    <Modal title="Hours & Categories" onClose={onClose} wide
      footer={<button onClick={() => onSave(cats)} className="px-4 py-1.5 rounded-lg text-sm font-semibold text-white" style={{ background: T.accent }}>Save</button>}>
      <p className="text-xs mb-3" style={{ color: T.dim }}>
        Tasks only roll over inside their category's hours. Add a dated exception for holidays or one-off changes.
      </p>
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
  return { ...base, left: 2 + lay.col * 10, right: 4, indent: lay.col };
}
function geomStyle(g) {
  if (g.split) return { top: g.top, height: g.height, left: `calc(${g.leftPct}% + 1px)`, width: `calc(${g.widthPct}% - 3px)` };
  return { top: g.top, height: g.height, left: g.left, right: g.right };
}

function EventBlock({ occ, lay, hourH, dragPreview, beginDrag, openEvent, openMaps }) {
  const T = useT();
  if (dragPreview && dragPreview.key === occ.renderKey) return null;
  const c = colorSet(occ.ev.color, T.mode);
  const start = occ.dispStart;
  const end = Math.min(occ.dispEnd, 1440);
  const g = blockGeom(lay, hourH, start, end);
  const compact = g.height < 34;
  return (
    <div className="absolute rounded-lg overflow-hidden cursor-grab active:cursor-grabbing select-none group/ev"
      onPointerDown={(e) => beginDrag(e, { type: "event", occ }, "move")}
      onClick={(e) => { e.stopPropagation(); openEvent(occ); }}
      style={{ ...geomStyle(g), background: c.bg, borderLeft: `3px solid ${c.border}`, zIndex: lay ? lay.z : 2, touchAction: "none" }}>
      <div className="px-1.5 py-0.5 pointer-events-none">
        <div className="text-xs font-semibold truncate" style={{ color: c.text, lineHeight: compact ? "1.1" : "1.3" }}>{occ.ev.repeat && occ.ev.repeat !== "none" ? "↻ " : ""}{occ.ev.title}</div>
        {g.height >= 40 && (
          <div className="text-[10px] truncate" style={{ color: c.text, opacity: 0.7 }}>
            {toAmPm(start)} – {toAmPm(occ.dispEnd % 1440)}{occ.dispEnd > 1440 ? " ⁺¹" : ""}{occ.ev.tz !== deviceTz ? ` · ${tzLabel(occ.ev.tz, occ.startUtc)}` : ""}
          </div>
        )}
        {g.height >= 64 && occ.ev.location && (
          <div className="text-[10px] truncate pointer-events-auto cursor-pointer" style={{ color: c.text, opacity: 0.7 }}
            onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); openMaps(occ.ev.location); }}>📍 {occ.ev.location.name}</div>
        )}
      </div>
      <div className="absolute left-0 right-0 top-0 h-2 opacity-0 group-hover/ev:opacity-100 cursor-row-resize flex justify-center"
        onPointerDown={(e) => beginDrag(e, { type: "event", occ }, "resize-start")} style={{ touchAction: "none" }}>
        <div className="rounded-full mt-0.5" style={{ width: 24, height: 3, background: c.border, opacity: 0.7 }} />
      </div>
      <div className="absolute left-0 right-0 bottom-0 h-2 opacity-0 group-hover/ev:opacity-100 cursor-row-resize flex justify-center items-end"
        onPointerDown={(e) => beginDrag(e, { type: "event", occ }, "resize-end")} style={{ touchAction: "none" }}>
        <div className="rounded-full mb-0.5" style={{ width: 24, height: 3, background: c.border, opacity: 0.7 }} />
      </div>
    </div>
  );
}

function TaskBlock({ item, lay, hourH, dragPreview, beginDrag, openTask, toggleTask }) {
  const T = useT();
  const t = item.task;
  if (!item.done && dragPreview && dragPreview.key === "task_" + t.id) return null;
  const p = prioSet(item.effPriority || t.priority, T.mode);
  const done = !!item.done;
  const c = done ? colorSet("green", T.mode) : p;
  const overdue = !done && ((t.deadline && item.date > t.deadline) || item.overdue);
  const g = blockGeom(lay, hourH, item.start, item.end);
  const compact = g.height < 34;
  return (
    <div className={`absolute rounded-lg overflow-hidden select-none group/tk ${done ? "" : "cursor-grab active:cursor-grabbing"}`}
      onPointerDown={(e) => { if (!done) beginDrag(e, { type: "task", item }, "move"); }}
      onClick={(e) => { e.stopPropagation(); openTask(t); }}
      style={{ ...geomStyle(g), background: c.bg, borderLeft: `3px dashed ${overdue ? T.danger : c.border}`, zIndex: lay ? lay.z : 2, opacity: done ? 0.6 : 1, touchAction: done ? "auto" : "none" }}
      title={done ? "Completed" : item.pinned ? "Pinned time — drag to move" : "Auto-scheduled — drag to pin a time"}>
      <div className="flex items-start gap-1 px-1 py-0.5">
        <div className="mt-0.5"><Check checked={done} onToggle={() => toggleTask(t.id)} color={c.border} /></div>
        <div className="min-w-0 pointer-events-none">
          <div className={`text-xs font-semibold truncate ${done ? "line-through" : ""}`} style={{ color: c.text, lineHeight: compact ? "1.1" : "1.3" }}>
            {!done && item.pinned ? "📌 " : ""}{t.title}
          </div>
          {g.height >= 40 && <div className="text-[10px] truncate" style={{ color: c.text, opacity: 0.7 }}>{toAmPm(item.start)} – {toAmPm(item.end)}{overdue ? " · overdue" : ""}</div>}
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
function TimeGrid({ days, now, nowMin, hourH, isMobile, allDayByDay, timedByDay, tasksByDay, layoutFor, unionWindows, scrollRef, gridBodyRef, gutter, dragPreview, createPreview, beginDrag, beginCreate, onGridPointerDown, openEvent, openTask, toggleTask, openMaps, transition }) {
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
                    style={{ background: ACCENTS[o.ev.color] || ACCENTS.blue }}>{o.ev.holiday ? "🎌 " : ""}{o.ev.title}</button>
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
                  <EventBlock key={occ.renderKey} occ={occ} lay={lay} hourH={hourH} dragPreview={dragPreview} beginDrag={beginDrag} openEvent={openEvent} openMaps={openMaps} />
                ))}
                {laid.tasks.map(({ item, lay }) => (
                  <TaskBlock key={"task_" + item.task.id + (item.done ? "_done" : "")} item={item} lay={lay} hourH={hourH} dragPreview={dragPreview} beginDrag={beginDrag} openTask={openTask} toggleTask={toggleTask} />
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
                if (x.kind === "allday") return <div key={i} className="truncate rounded px-1 mb-0.5 text-[10px] font-semibold text-white" style={{ background: ACCENTS[x.o.ev.color] || ACCENTS.blue }}>{x.o.ev.title}</div>;
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

/* ---------- holidays picker ---------- */
function HolidaysModal({ selected, country, onSave, onClose }) {
  const T = useT();
  const [sel, setSel] = useState(selected);
  const [ctry, setCtry] = useState(country);
  const toggle = (code) => setSel((s) => (s.includes(code) ? s.filter((x) => x !== code) : [...s, code]));
  return (
    <Modal title="Holiday Calendars" onClose={onClose} wide
      footer={<button onClick={() => onSave(sel, ctry)} className="px-4 py-1.5 rounded-lg text-sm font-semibold text-white" style={{ background: T.accent }}>Save</button>}>
      <p className="text-xs mb-3" style={{ color: T.dim }}>
        Add public holidays as all-day events. Your country sets the default time zone for new events too.
      </p>
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
              {on && <span style={{ color: colorSet(c.color, T.mode).border }}>✓</span>}
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

/* ==================================================================== */
export default function Planner() {
  const [mode, setMode] = useState(() => { try { return localStorage.getItem("rollover-theme") || "dark"; } catch { return "dark"; } });
  const T = THEMES[mode];
  useEffect(() => { try { localStorage.setItem("rollover-theme", mode); } catch { /* private mode */ } }, [mode]);

  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [events, setEvents] = useState([]);
  const [categories, setCategories] = useState(DEFAULT_CATEGORIES);
  const [holidayCals, setHolidayCals] = useState([]);
  const [holidayCache, setHolidayCache] = useState({});
  const [country, setCountry] = useState(() => guessCountry());
  const [now, setNow] = useState(new Date());
  const [view, setView] = useState("week");
  const [anchor, setAnchor] = useState(new Date());
  const [itemDraft, setItemDraft] = useState(null);
  const [showCats, setShowCats] = useState(false);
  const [showHolidays, setShowHolidays] = useState(false);
  const [quickTitle, setQuickTitle] = useState("");
  const [saveState, setSaveState] = useState("idle");
  const [syncErr, setSyncErr] = useState("");
  const [dragPreview, setDragPreview] = useState(null);
  const [createPreview, setCreatePreview] = useState(null);
  const [hourH, setHourH] = useState(HOUR_H_BASE);
  const [gutter, setGutter] = useState(0);
  const [transition, setTransition] = useState(false);
  const [isMobile, setIsMobile] = useState(() => (typeof window !== "undefined" ? window.innerWidth < 640 : false));
  const [drawerOpen, setDrawerOpen] = useState(false);
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

  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30000); return () => clearInterval(t); }, []);
  useEffect(() => { initIdentity((u) => { setUser(u); setAuthReady(true); }); }, []);

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

  useEffect(() => {
    if (!authReady) return;
    let alive = true;
    (async () => {
      try {
        const d = await loadData(user);
        if (!alive) return;
        if (d) {
          const m = migrate(d);
          setTasks(m.tasks); setEvents(m.events); setCategories(m.categories);
          setHolidayCals(m.holidayCals); setHolidayCache(m.holidayCache); setCountry(m.country);
        } else if (user) {
          const raw = localStorage.getItem(STORE_KEY);
          if (raw) {
            const m = migrate(JSON.parse(raw));
            setTasks(m.tasks); setEvents(m.events); setCategories(m.categories);
            setHolidayCals(m.holidayCals); setHolidayCache(m.holidayCache); setCountry(m.country);
            saveData(user, m).catch(() => {});
          }
        }
      } catch (err) { setSaveState("error"); setSyncErr(explainSyncError(err)); }
      skipNextSave.current = true;
      setLoaded(true);
    })();
    return () => { alive = false; };
  }, [authReady, user]);

  useEffect(() => {
    if (!loaded) return;
    if (skipNextSave.current) { skipNextSave.current = false; return; }
    setSaveState("saving");
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        await saveData(user, { tasks, events, categories, holidayCals, holidayCache, country });
        setSaveState("saved");
        setTimeout(() => setSaveState("idle"), 1500);
      } catch (err) { setSaveState("error"); setSyncErr(explainSyncError(err)); }
    }, 500);
    return () => clearTimeout(saveTimer.current);
  }, [tasks, events, categories, holidayCals, holidayCache, country, loaded, user]);

  /* land on the current time; only view changes re-scroll */
  useEffect(() => {
    if (!loaded || (view !== "week" && view !== "day")) return;
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        const m = new Date();
        scrollRef.current.scrollTop = Math.max(0, ((m.getHours() * 60 + m.getMinutes()) / 60) * hourHRef.current - 150);
      }
    });
  }, [view, loaded]);

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
    return { start: dateKey(anchor), end: dateKey(anchor) };
  }, [view, anchor, isMobile]);

  /* fetch any holiday years we don't yet have cached for the visible range */
  useEffect(() => {
    if (!holidayCals.length) return;
    const years = yearsForRange(range.start, range.end);
    const missing = [];
    for (const code of holidayCals) for (const y of years) if (!holidayCache[`${code}_${y}`]) missing.push([code, y]);
    if (!missing.length) return;
    let alive = true;
    (async () => {
      const adds = {};
      for (const [code, y] of missing) {
        try { adds[`${code}_${y}`] = await fetchHolidays(code, y); }
        catch { adds[`${code}_${y}`] = []; }
      }
      if (alive) setHolidayCache((c) => ({ ...c, ...adds }));
    })();
    return () => { alive = false; };
  }, [holidayCals, range, holidayCache]);

  /* holiday events materialised as all-day events for the visible range */
  const holidayEvents = useMemo(() => {
    const out = [];
    const years = yearsForRange(range.start, range.end);
    for (const code of holidayCals) {
      const cal = calByCode(code);
      for (const y of years) {
        for (const h of holidayCache[`${code}_${y}`] || []) {
          if (h.date < range.start || h.date > range.end) continue;
          out.push({ id: `hol_${code}_${h.date}`, title: h.name, date: h.date, start: 0, end: 1440, allDay: true, tz: cal?.tz || deviceTz, color: cal?.color || "red", repeat: "none", exceptions: [], location: null, holiday: true, holidayCountry: code });
        }
      }
    }
    return out;
  }, [holidayCals, holidayCache, range]);

  const occurrences = useMemo(() => {
    const evOcc = expandOccurrences(events, range.start, range.end, deviceTz);
    const holOcc = holidayEvents.map((ev) => ({ ev, occDate: ev.date, allDay: true, dispDate: ev.date, renderKey: ev.id }));
    return [...evOcc, ...holOcc];
  }, [events, range, holidayEvents]);
  const schedule = useMemo(() => scheduleTasks(tasks, events, categories, now, deviceTz), [tasks, events, categories, now]);

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
      if (s) (m[s.date] ||= []).push({ task: t, ...s, done: false, effPriority: effectivePriority(t, todayKey) });
    }
    return m;
  }, [tasks, schedule, todayKey]);

  /* per-day overlap layout, memoised */
  const layoutFor = useCallback((key) => {
    const evs = (timedByDay[key] || []).map((occ) => ({ id: "e_" + occ.renderKey, start: occ.dispStart, end: Math.min(occ.dispEnd, 1440), ref: occ, kind: "event" }));
    const tks = (tasksByDay[key] || []).map((it) => ({ id: "t_" + it.task.id, start: it.start, end: Math.min(it.end, 1440), ref: it, kind: "task" }));
    const clearance = Math.max(8, Math.round((26 / hourH) * 60));
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
    setTasks((ts) => [...ts, { id: uid(), title: quickTitle.trim(), duration: 60, deadline: null, priority: 2, category: categories[0]?.id, done: false, createdAt: Date.now(), scheduledAt: null, autoReschedule: true, completedSlot: null }]);
    setQuickTitle("");
  };
  const saveTask = (t) => { setTasks((ts) => { const i = ts.findIndex((x) => x.id === t.id); if (i === -1) return [...ts, t]; const c = ts.slice(); c[i] = t; return c; }); setItemDraft(null); };
  const saveEvent = (ev) => { setEvents((es) => { const i = es.findIndex((x) => x.id === ev.id); if (i === -1) return [...es, ev]; const c = es.slice(); c[i] = ev; return c; }); setItemDraft(null); };
  const deleteSeries = (id) => { setEvents((es) => es.filter((e) => e.id !== id)); setItemDraft(null); };
  const deleteOccurrence = (id, occDate) => { setEvents((es) => es.map((e) => (e.id === id ? { ...e, exceptions: [...(e.exceptions || []), occDate] } : e))); setItemDraft(null); };

  const openEvent = useCallback((occ) => {
    if (dragRef.current?.moved) return;
    if (occ.ev.holiday) return; /* holidays are read-only */
    setItemDraft({ ...occ.ev, itemType: "event", occDate: occ.occDate });
  }, []);
  const openTask = useCallback((t) => { if (!dragRef.current?.moved) setItemDraft({ ...t, itemType: "task" }); }, []);
  const openMaps = useCallback((loc) => window.open(`https://www.google.com/maps/search/?api=1&query=${loc.lat},${loc.lon}`, "_blank"), []);

  /* view switch with a short cross-fade/scale */
  const VIEW_ORDER = ["day", "week", "month"];
  const changeView = useCallback((v) => {
    setView((cur) => {
      if (v === cur) return cur;
      setTransition(true);
      setTimeout(() => setTransition(false), 260);
      return v;
    });
  }, []);
  const zoomView = useCallback((dir) => {
    /* dir -1 = toward day (in), +1 = toward month (out) */
    setView((cur) => {
      const i = VIEW_ORDER.indexOf(cur);
      const ni = Math.min(VIEW_ORDER.length - 1, Math.max(0, i + dir));
      if (ni === i) return cur;
      setTransition(true);
      setTimeout(() => setTransition(false), 260);
      return VIEW_ORDER[ni];
    });
  }, []);

  const visibleN = view === "day" ? 1 : isMobile ? 3 : 7;
  const anchorKeyRef = useRef(dateKey(anchor));
  anchorKeyRef.current = dateKey(anchor);
  const visNRef = useRef(visibleN);
  visNRef.current = visibleN;
  const days = useMemo(() => {
    if (view === "month") return [];
    return Array.from({ length: visibleN }, (_, i) => addDays(anchor, i));
  }, [view, anchor, visibleN]);

  const shift = useCallback((dir) => {
    lastDirRef.current = dir;
    setAnchor((a) => {
      if (view === "month") { const d = new Date(a); d.setMonth(d.getMonth() + dir); return d; }
      return addDays(a, dir * (view === "week" ? (isMobile ? 3 : 7) : 1));
    });
  }, [view, isMobile]);

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
    e.stopPropagation();
    const isTouch = e.pointerType === "touch";
    const disp = target.type === "event"
      ? { date: target.occ.dispDate, start: target.occ.dispStart, end: target.occ.dispEnd }
      : { date: target.item.date, start: target.item.start, end: target.item.end };
    const meta = target.type === "event"
      ? { title: target.occ.ev.title, colorName: target.occ.ev.color, dashed: false }
      : { title: target.item.task.title, colorName: PRIORITY[target.item.task.priority]?.c || "blue", dashed: true };
    const st = { target, mode, disp, meta, x0: e.clientX, y0: e.clientY, active: !isTouch, moved: false, dayDelta: 0, minDelta: 0, timer: null };
    if (isTouch) st.timer = setTimeout(() => { st.active = true; if (navigator.vibrate) navigator.vibrate(15); }, 400);
    dragRef.current = st;

    const move = (ev) => {
      const s = dragRef.current;
      if (!s) return;
      const dx = ev.clientX - s.x0, dy = ev.clientY - s.y0;
      if (!s.active) { if (Math.hypot(dx, dy) > 10) { clearTimeout(s.timer); cleanup(); } return; }
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
        if (s.active && s.moved && s.preview) commitDrag(s);
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
        st.active = true;
        st.floating = true;
        if (navigator.vibrate) navigator.vibrate(15);
        /* stop the browser claiming the gesture for scrolling — a claimed
           gesture fires pointercancel, which used to pop the editor early */
        st.blockTouch = (te) => te.preventDefault();
        window.addEventListener("touchmove", st.blockTouch, { passive: false });
        placeFloating(st.lx, st.ly);
      }, 400);
    }
    dragRef.current = st;

    const move = (ev) => {
      const s = dragRef.current;
      if (!s || !s.create) return;
      s.lx = ev.clientX; s.ly = ev.clientY;
      const dx = ev.clientX - s.x0, dy = ev.clientY - s.y0;
      if (!s.active) { if (Math.hypot(dx, dy) > 10) { clearTimeout(s.timer); cleanup(); } return; }
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
      if (cur) {
        clearInterval(cur.edgeTimer);
        if (cur.blockTouch) window.removeEventListener("touchmove", cur.blockTouch);
      }
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
  }, [stepDay]);

  const unionWindows = useCallback((key) => {
    const wins = categories.map((c) => windowFor(c, key)).filter(Boolean);
    if (!wins.length) return null;
    return { start: Math.min(...wins.map((w) => w.start)), end: Math.max(...wins.map((w) => w.end)) };
  }, [categories]);

  /* ---------- multitouch: pinch to zoom (vertical, anchored at the pinch
     centre) / switch view (horizontal), plus horizontal swipe that snaps
     day-by-day as the finger keeps moving ---------- */
  const onGridPointerDown = useCallback((e) => {
    if (e.pointerType !== "touch") return;
    const g = gestureRef.current || (gestureRef.current = { pts: new Map() });
    g.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (g.pts.size === 2) {
      const [a, b] = [...g.pts.values()];
      g.startDx = Math.abs(a.x - b.x);
      g.startDy = Math.abs(a.y - b.y);
      g.startHourH = hourHRef.current;
      g.axis = null;
      g.pinching = true;
      /* remember which minute sits under the pinch centre so zoom keeps it fixed */
      if (scrollRef.current) {
        const rect = scrollRef.current.getBoundingClientRect();
        const centerY = (a.y + b.y) / 2 - rect.top;
        g.anchorMinute = ((scrollRef.current.scrollTop + centerY) / g.startHourH) * 60;
        g.anchorOffsetY = centerY;
      }
      if (dragRef.current) { dragRef.current = null; setCreatePreview(null); setDragPreview(null); } /* cancel single-finger drag/create */
    } else if (g.pts.size === 1) {
      g.swipeX0 = e.clientX; g.swipeY0 = e.clientY; g.swipeAxis = null;
    }

    const move = (ev) => {
      const pt = g.pts.get(ev.pointerId);
      if (!pt) return;
      pt.x = ev.clientX; pt.y = ev.clientY;

      if (g.pinching && g.pts.size === 2) {
        ev.preventDefault();
        const [a, b] = [...g.pts.values()];
        const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
        if (!g.axis) {
          const cdx = Math.abs(dx - g.startDx), cdy = Math.abs(dy - g.startDy);
          if (cdx > 24 || cdy > 24) g.axis = cdy >= cdx ? "v" : "h";
        }
        if (g.axis === "v") {
          const ratio = dy / (g.startDy || 1);
          const next = Math.round(Math.min(HOUR_H_MAX, Math.max(HOUR_H_MIN, g.startHourH * ratio)));
          if (g.anchorMinute != null) zoomAnchor.current = { minute: g.anchorMinute, offsetY: g.anchorOffsetY };
          setHourH(next);
        } else if (g.axis === "h" && !g.fired) {
          const ratio = dx / (g.startDx || 1);
          if (ratio < 0.6) { g.fired = true; zoomView(-1); }       /* pinch in -> more detail */
          else if (ratio > 1.6) { g.fired = true; zoomView(1); }   /* spread -> less detail */
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
    const up = (ev) => {
      g.pts.delete(ev.pointerId);
      if (g.pts.size < 2) { g.pinching = false; g.axis = null; g.fired = false; }
      if (g.pts.size === 0) {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        gestureRef.current = null;
      }
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }, [zoomView, stepDay]);

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
      setHourH((h) => Math.round(Math.min(HOUR_H_MAX, Math.max(HOUR_H_MIN, h * (e.deltaY < 0 ? 1.1 : 0.9)))));
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

  /* slide animation when the visible days move */
  const firstAnchor = useRef(true);
  useEffect(() => {
    if (firstAnchor.current) { firstAnchor.current = false; return; }
    const el = view === "month" ? null : gridBodyRef.current;
    if (!el) return;
    const cls = lastDirRef.current > 0 ? "rl-slide-l" : "rl-slide-r";
    el.classList.remove("rl-slide-l", "rl-slide-r");
    void el.offsetWidth; /* restart the animation */
    el.classList.add(cls);
    const t = setTimeout(() => el.classList.remove(cls), 240);
    return () => clearTimeout(t);
  }, [anchor]); // eslint-disable-line react-hooks/exhaustive-deps


  const title = (() => {
    if (view === "month") return `${MONTHS[anchor.getMonth()]} ${anchor.getFullYear()}`;
    if (view === "day") return isMobile ? `${MONTHS[anchor.getMonth()].slice(0, 3)} ${anchor.getDate()}` : `${MONTHS[anchor.getMonth()]} ${anchor.getDate()}, ${anchor.getFullYear()}`;
    const we = addDays(anchor, (isMobile ? 3 : 7) - 1);
    const m1 = MONTHS[anchor.getMonth()].slice(0, 3), m2 = MONTHS[we.getMonth()].slice(0, 3);
    if (isMobile) return anchor.getMonth() === we.getMonth() ? `${m1} ${anchor.getDate()} – ${we.getDate()}` : `${m1} ${anchor.getDate()} – ${m2} ${we.getDate()}`;
    return anchor.getMonth() === we.getMonth() ? `${MONTHS[anchor.getMonth()]} ${anchor.getFullYear()}` : `${m1} – ${m2} ${we.getFullYear()}`;
  })();

  const pendingTasks = tasks.filter((t) => !t.done).sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
  const doneTasks = tasks.filter((t) => t.done).sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
  const catName = (id) => categories.find((c) => c.id === id)?.name || "—";

  if (!loaded) {
    return (
      <ThemeCtx.Provider value={T}>
        <div className="h-screen flex items-center justify-center text-sm" style={{ color: T.dim, background: T.bg, fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }}>Loading Rollover…</div>
      </ThemeCtx.Provider>
    );
  }

  return (
    <ThemeCtx.Provider value={T}>
      <style>{`.rl-hover:hover{background:${T.hover}} html{color-scheme:${mode}} ::-webkit-scrollbar{width:10px;height:10px} ::-webkit-scrollbar-thumb{background:${T.mode === "dark" ? "#3a3a3e" : "#c9c9ce"};border-radius:5px;border:2px solid ${T.surface}} ::-webkit-scrollbar-track{background:transparent} @keyframes rlFade{0%{opacity:0;transform:scale(0.985)}100%{opacity:1;transform:scale(1)}} .rl-fade{animation:rlFade 0.26s cubic-bezier(0.22,0.61,0.36,1)} @keyframes rlSlideL{0%{opacity:0.5;transform:translateX(26px)}100%{opacity:1;transform:none}} @keyframes rlSlideR{0%{opacity:0.5;transform:translateX(-26px)}100%{opacity:1;transform:none}} .rl-slide-l{animation:rlSlideL 0.22s ease-out} .rl-slide-r{animation:rlSlideR 0.22s ease-out} @media (prefers-reduced-motion: reduce){.rl-slide-l,.rl-slide-r{animation:none}} @media (max-width:640px){input,select,textarea{font-size:16px !important}} @keyframes rlSheet{0%{transform:translateY(48px);opacity:0.55}100%{transform:none;opacity:1}} .rl-sheet{animation:rlSheet 0.24s cubic-bezier(0.22,0.61,0.36,1)} @media (prefers-reduced-motion: reduce){.rl-sheet{animation:none}} *{-webkit-touch-callout:none} input,textarea{-webkit-user-select:text;user-select:text} @media (prefers-reduced-motion: reduce){.rl-fade{animation:none}}`}</style>
      <div className="h-screen flex select-none" style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", background: T.bg, color: T.text, colorScheme: mode }}>
        {/* ---------- sidebar (drawer on mobile) ---------- */}
        {isMobile && drawerOpen && <div className="fixed inset-0 z-30" style={{ background: "rgba(0,0,0,0.45)" }} onClick={() => setDrawerOpen(false)} />}
        {(!isMobile || drawerOpen) && (
        <div className={isMobile ? "fixed inset-y-0 left-0 z-40 w-72 flex flex-col border-r" : "w-72 flex-shrink-0 flex flex-col border-r"}
          style={{ borderColor: T.border, background: T.surface, boxShadow: isMobile ? T.shadow : "none" }}>
          <div className="px-4 pt-4 pb-2 flex items-center justify-between">
            <h2 className="font-bold text-lg flex items-center gap-1.5" style={{ color: T.text }}>
              <span aria-hidden="true" style={{ color: T.accent }}>↻</span>Rollover
            </h2>
            <button className="text-[10px] text-left" style={{ color: saveState === "error" ? T.danger : T.faint, cursor: saveState === "error" ? "pointer" : "default" }}
              title={saveState === "error" ? syncErr : ""} onClick={() => { if (saveState === "error" && syncErr) alert(syncErr); }}>
              {saveState === "saving" ? (user ? "syncing…" : "saving…") : saveState === "saved" ? (user ? "synced" : "saved") : saveState === "error" ? "sync failed — tap for details" : ""}
            </button>
          </div>

          <div className="px-4 pb-3 flex gap-1.5">
            <input value={quickTitle} onChange={(e) => setQuickTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && quickAdd()}
              placeholder="Quick task — Enter to add" className="flex-1 rounded-lg px-3 py-2 text-sm min-w-0" style={inputStyle(T)} />
            <button onClick={() => setItemDraft({ itemType: "task", title: quickTitle })} title="New task with details"
              className="rounded-lg text-white font-bold text-sm px-3" style={{ background: T.accent }}>＋</button>
          </div>

          <div className="flex-1 overflow-y-auto px-2">
            {pendingTasks.length === 0 && <p className="text-xs text-center mt-6 px-4" style={{ color: T.dim }}>No tasks yet. Quick-add above, or tap ＋ to set a time, priority, and category.</p>}
            {pendingTasks.map((t) => {
              const slot = schedule[t.id];
              const p = prioSet(t.priority, T.mode);
              const overdue = slot && ((t.deadline && slot.date > t.deadline) || (slot.pinned && (slot.date < dateKey(now) || (slot.date === dateKey(now) && slot.end <= nowMin))));
              return (
                <div key={t.id} className="group flex items-start gap-2 px-2 py-2 rounded-lg rl-hover cursor-pointer" onClick={() => openTask(t)}>
                  <div className="mt-0.5"><Check checked={false} onToggle={() => toggleTask(t.id)} color={p.dot} /></div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate flex items-center gap-1.5" style={{ color: T.text }}>
                      <span className="rounded-full flex-shrink-0" style={{ width: 6, height: 6, background: p.dot }} />{t.title}
                    </div>
                    <div className="text-[11px]" style={{ color: overdue ? T.danger : T.dim }}>
                      {slot ? `${slot.pinned ? "📌 " : ""}${sameDay(parseKey(slot.date), now) ? "Today" : `${DOW[dowOfKey(slot.date)]} ${+slot.date.slice(8)}`} · ${toAmPm(slot.start)}` : "No slot in next 4 weeks"}
                      {" · "}{t.duration < 60 ? `${t.duration}m` : `${t.duration / 60}h`} · {catName(t.category)}{overdue ? " · overdue" : ""}
                    </div>
                  </div>
                  <button onClick={(e) => { e.stopPropagation(); deleteTask(t.id); }} className="opacity-0 group-hover:opacity-100 text-xs px-1" style={{ color: T.faint }} aria-label="Delete task">✕</button>
                </div>
              );
            })}
            {doneTasks.length > 0 && (
              <>
                <div className="text-[10px] uppercase tracking-wide px-2 mt-3 mb-1" style={{ color: T.dim }}>Completed</div>
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

          <div className="px-4 py-3 border-t flex flex-col gap-1.5" style={{ borderColor: T.border }}>
            <button onClick={() => setShowCats(true)} className="text-xs font-medium text-left" style={{ color: T.accent }}>⚙ Hours & categories</button>
            <button onClick={() => setShowHolidays(true)} className="text-xs font-medium text-left" style={{ color: T.accent }}>🎌 Holiday calendars{holidayCals.length ? ` (${holidayCals.length})` : ""}</button>
            {isMobile && <button onClick={() => setMode(mode === "dark" ? "light" : "dark")} className="text-xs font-medium text-left" style={{ color: T.accent }}>{mode === "dark" ? "☀ Light mode" : "☾ Dark mode"}</button>}
            {user ? (
              <div className="flex items-center justify-between">
                <span className="text-[11px] truncate" style={{ color: T.dim }}>{user.email}</span>
                <button onClick={doLogout} className="text-xs font-medium" style={{ color: T.danger }}>Sign out</button>
              </div>
            ) : <button onClick={openLogin} className="text-xs font-medium text-left" style={{ color: T.accent }}>Sign in to sync across devices</button>}
          </div>
        </div>
        )}

        {/* ---------- calendar ---------- */}
        <div className="flex-1 flex flex-col min-w-0" style={{ background: T.surface }}>
          <div className={`flex items-center border-b ${isMobile ? "gap-1 px-2 py-2" : "gap-2 px-4 py-2.5"}`} style={{ borderColor: T.border }}>
            {isMobile && (
              <button onClick={() => setDrawerOpen(true)} className="relative rounded-lg px-2 py-1.5 text-sm" style={{ background: T.surface2, color: T.text }} aria-label="Open tasks">
                ☰{pendingTasks.length > 0 && <span className="absolute -top-1 -right-1 rounded-full text-[9px] font-bold text-white flex items-center justify-center" style={{ background: T.danger, minWidth: 15, height: 15, padding: "0 3px" }}>{pendingTasks.length}</span>}
              </button>
            )}
            <h1 className={`font-bold ${isMobile ? "text-sm mr-1" : "text-lg mr-2"}`} style={{ color: T.text }}>{title}</h1>
            <div className="flex rounded-lg overflow-hidden text-xs font-medium" style={{ background: T.surface2 }}>
              {["day", "week", "month"].map((v) => (
                <button key={v} onClick={() => changeView(v)} className="px-3 py-1.5 capitalize"
                  style={{ background: view === v ? (T.mode === "dark" ? "#3a3a3e" : "white") : "transparent", color: view === v ? T.text : T.dim, boxShadow: view === v ? "0 1px 2px rgba(0,0,0,0.15)" : "none", borderRadius: 7, margin: 2 }}>{v}</button>
              ))}
            </div>
            <div className="flex-1" />
            {!isMobile && <button onClick={() => setMode(mode === "dark" ? "light" : "dark")} className="px-2 py-1 text-sm rounded-md" style={{ color: T.dim }} title="Toggle dark mode" aria-label="Toggle dark mode">{mode === "dark" ? "☀" : "☾"}</button>}
            {!isMobile && <button onClick={() => { lastDirRef.current = -1; shift(-1); }} className="px-2 py-1 text-sm" style={{ color: T.accent }} aria-label="Previous">‹</button>}
            <button onClick={() => { lastDirRef.current = 1; setAnchor(new Date()); }} className="px-2.5 py-1 text-xs font-medium" style={{ color: T.accent }}>Today</button>
            {!isMobile && <button onClick={() => { lastDirRef.current = 1; shift(1); }} className="px-2 py-1 text-sm" style={{ color: T.accent }} aria-label="Next">›</button>}
            <button onClick={() => setItemDraft({ itemType: "event", date: dateKey(anchor), start: Math.min(Math.ceil(nowMin / 30) * 30, 23 * 60), end: Math.min(Math.ceil(nowMin / 30) * 30 + 60, 1440), color: "blue", tz: deviceTz })}
              className={`ml-1 rounded-lg text-white font-semibold text-xs ${isMobile ? "px-2.5 py-1.5" : "px-3 py-1.5"}`} style={{ background: T.accent }}>{isMobile ? "＋" : "＋ New"}</button>
          </div>

          {isMobile && view !== "month" && (
            <WeekStrip anchor={anchor} now={now} visibleN={visibleN}
              onPickDay={(d) => { lastDirRef.current = d >= anchor ? 1 : -1; setAnchor(d); }}
              onSwipeWeek={(dir) => { lastDirRef.current = dir; setAnchor((a) => addDays(a, dir * 7)); }} />
          )}
          {view === "month" ? (
            <div key={`${anchor.getFullYear()}-${anchor.getMonth()}`} className={`flex-1 flex flex-col min-h-0 ${transition ? "rl-fade" : lastDirRef.current > 0 ? "rl-slide-l" : "rl-slide-r"}`}
              onPointerDown={onGridPointerDown} style={{ touchAction: "pan-y" }}>
              <MonthGrid anchor={anchor} now={now} allDayByDay={allDayByDay} timedByDay={timedByDay} tasksByDay={tasksByDay}
                onOpenDay={(d) => { setAnchor(d); changeView("day"); }} />
            </div>
          ) : (
            <TimeGrid days={days} now={now} nowMin={nowMin} hourH={hourH} isMobile={isMobile} allDayByDay={allDayByDay} timedByDay={timedByDay} tasksByDay={tasksByDay}
              layoutFor={layoutFor} unionWindows={unionWindows} scrollRef={scrollRef} gridBodyRef={gridBodyRef} gutter={gutter}
              dragPreview={dragPreview} createPreview={createPreview} beginDrag={beginDrag} beginCreate={beginCreate} onGridPointerDown={onGridPointerDown}
              openEvent={openEvent} openTask={openTask} toggleTask={toggleTask} openMaps={openMaps} transition={transition} />
          )}
        </div>

        {itemDraft && (
          <ItemModal draft={itemDraft} events={events} categories={categories}
            onSaveEvent={saveEvent} onSaveTask={saveTask}
            onDeleteSeries={deleteSeries} onDeleteOccurrence={deleteOccurrence} onDeleteTask={deleteTask}
            onClose={() => setItemDraft(null)} />
        )}
        {showCats && <CategoriesModal categories={categories} onSave={(cs) => { setCategories(cs); setShowCats(false); }} onClose={() => setShowCats(false)} />}
        {showHolidays && <HolidaysModal selected={holidayCals} country={country} onSave={(sel, c) => { setHolidayCals(sel); setCountry(c); setShowHolidays(false); }} onClose={() => setShowHolidays(false)} />}
      </div>
    </ThemeCtx.Provider>
  );
}
