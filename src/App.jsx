import { useState, useEffect, useMemo, useRef, useCallback, useContext, createContext } from "react";
import tzlookup from "tz-lookup";
import {
  toAmPm, MONTHS, DOW, deviceTz,
  dateKey, parseKey, addDays, startOfWeek, sameDay,
  addDaysKey, dowOfKey, diffDaysKey,
  wallToUtc, utcToWall, timeZoneList, tzLabel,
} from "./time.js";
import { expandOccurrences, scheduleTasks, windowFor } from "./scheduler.js";
import { initIdentity, openLogin, doLogout, loadData, saveData, STORE_KEY } from "./storage.js";

const HOUR_H = 48;
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

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
  out.events = out.events.map((e) => ({ tz: deviceTz, repeat: "none", allDay: false, exceptions: [], location: null, ...e }));
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
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.45)" }} onClick={onClose}>
      <div className={`rounded-2xl w-full ${wide ? "max-w-lg" : "max-w-sm"} max-h-full overflow-y-auto`}
        onClick={(e) => e.stopPropagation()} style={{ background: T.surface, boxShadow: T.shadow, border: `1px solid ${T.border}` }}>
        <div className="px-5 pt-4 pb-2 flex items-center justify-between sticky top-0 rounded-t-2xl" style={{ background: T.surface }}>
          <h3 className="font-semibold text-base" style={{ color: T.text }}>{title}</h3>
          <button onClick={onClose} className="text-sm" style={{ color: T.dim }}>✕</button>
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
      onSaveEvent({
        exceptions: [], createdAt: Date.now(), ...draft,
        id: draft.id || uid(), title: title.trim(), date, allDay,
        start: allDay ? 0 : start, end: allDay ? 1440 : Math.max(end, start + 15),
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
            {seg("event", "Event — fixed time")}{seg("task", "Task — auto-schedules")}
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
            <Row label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="rounded-md px-2 py-1 text-sm" style={selStyle(T)} /></Row>
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
function EventBlock({ occ, dragPreview, beginDrag, openEvent, openMaps }) {
  const T = useT();
  if (dragPreview && dragPreview.key === occ.renderKey) return null;
  const c = colorSet(occ.ev.color, T.mode);
  const start = occ.dispStart;
  const end = Math.min(occ.dispEnd, 1440);
  return (
    <div className="absolute left-0.5 right-1 rounded-lg overflow-hidden cursor-grab active:cursor-grabbing select-none group/ev"
      onPointerDown={(e) => beginDrag(e, { type: "event", occ }, "move")}
      onClick={(e) => { e.stopPropagation(); openEvent(occ); }}
      style={{ top: (start / 60) * HOUR_H, height: Math.max(((end - start) / 60) * HOUR_H - 2, 18), background: c.bg, borderLeft: `3px solid ${c.border}`, zIndex: 2, touchAction: "none" }}>
      <div className="px-1.5 py-0.5 pointer-events-none">
        <div className="text-xs font-semibold truncate" style={{ color: c.text }}>{occ.ev.repeat && occ.ev.repeat !== "none" ? "↻ " : ""}{occ.ev.title}</div>
        {end - start >= 40 && (
          <div className="text-[10px] truncate" style={{ color: c.text, opacity: 0.7 }}>
            {toAmPm(start)} – {toAmPm(occ.dispEnd % 1440)}{occ.dispEnd > 1440 ? " ⁺¹" : ""}{occ.ev.tz !== deviceTz ? ` · ${tzLabel(occ.ev.tz, occ.startUtc)}` : ""}
          </div>
        )}
        {end - start >= 64 && occ.ev.location && (
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

function TaskBlock({ item, dragPreview, beginDrag, openTask, toggleTask }) {
  const T = useT();
  const t = item.task;
  if (!item.done && dragPreview && dragPreview.key === "task_" + t.id) return null;
  const p = prioSet(t.priority, T.mode);
  const done = !!item.done;
  const c = done ? colorSet("green", T.mode) : p;
  const overdue = !done && ((t.deadline && item.date > t.deadline) || item.overdue);
  return (
    <div className={`absolute left-0.5 right-1 rounded-lg px-1.5 py-0.5 overflow-hidden select-none group/tk ${done ? "" : "cursor-grab active:cursor-grabbing"}`}
      onPointerDown={(e) => { if (!done) beginDrag(e, { type: "task", item }, "move"); }}
      onClick={(e) => { e.stopPropagation(); openTask(t); }}
      style={{ top: (item.start / 60) * HOUR_H, height: Math.max(((item.end - item.start) / 60) * HOUR_H - 2, 18), background: c.bg, borderLeft: `3px dashed ${overdue ? T.danger : c.border}`, zIndex: 2, opacity: done ? 0.65 : 1, touchAction: done ? "auto" : "none" }}
      title={done ? "Completed" : item.pinned ? "Pinned time — drag to move" : "Auto-scheduled — drag to pin a time"}>
      <div className="flex items-start gap-1">
        <div className="mt-0.5"><Check checked={done} onToggle={() => toggleTask(t.id)} color={c.border} /></div>
        <div className="min-w-0 pointer-events-none">
          <div className={`text-xs font-semibold truncate ${done ? "line-through" : ""}`} style={{ color: c.text }}>
            {!done && item.pinned ? "📌 " : ""}{t.title}
          </div>
          {item.end - item.start >= 40 && (
            <div className="text-[10px] truncate" style={{ color: c.text, opacity: 0.7 }}>{toAmPm(item.start)} – {toAmPm(item.end)}{overdue ? " · overdue" : ""}</div>
          )}
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

function GhostBlock({ preview }) {
  const T = useT();
  const start = preview.dispStart;
  const end = Math.min(preview.dispEnd, 1440);
  return (
    <div className="absolute left-0.5 right-1 rounded-lg px-1.5 py-0.5 overflow-hidden pointer-events-none"
      style={{ top: (start / 60) * HOUR_H, height: Math.max(((end - start) / 60) * HOUR_H - 2, 18), background: preview.cset.bg, borderLeft: `3px ${preview.dashed ? "dashed" : "solid"} ${preview.cset.border}`, zIndex: 6, boxShadow: T.shadow }}>
      <div className="text-xs font-semibold truncate" style={{ color: preview.cset.text }}>{preview.title}</div>
      <div className="text-[10px]" style={{ color: preview.cset.text, opacity: 0.75 }}>{toAmPm(start)} – {toAmPm(preview.dispEnd % 1440)}</div>
    </div>
  );
}

/* ---------- time grid (week/day) ---------- */
function TimeGrid({ days, now, nowMin, allDayByDay, timedByDay, tasksByDay, unionWindows, scrollRef, gridBodyRef, dragPreview, createPreview, beginDrag, beginCreate, openEvent, openTask, toggleTask, openMaps }) {
  const T = useT();
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="border-b" style={{ borderColor: T.border }}>
        <div className="flex">
          <div style={{ width: 52 }} />
          {days.map((d) => {
            const isToday = sameDay(d, now);
            return (
              <div key={dateKey(d)} className="flex-1 text-center pt-1.5">
                <div className="text-[10px] uppercase tracking-wide" style={{ color: T.dim }}>{DOW[d.getDay()]}</div>
                <div className="text-sm font-semibold inline-flex items-center justify-center rounded-full"
                  style={{ width: 26, height: 26, background: isToday ? T.danger : "transparent", color: isToday ? "white" : T.text }}>{d.getDate()}</div>
              </div>
            );
          })}
        </div>
        <div className="flex" style={{ minHeight: 22 }}>
          <div style={{ width: 52 }} className="text-[9px] text-right pr-1.5 pt-0.5"><span style={{ color: T.faint }}>all-day</span></div>
          {days.map((d) => {
            const key = dateKey(d);
            return (
              <div key={key} className="flex-1 px-0.5 pb-1 flex flex-col gap-0.5 border-l" style={{ borderColor: T.gridLine }}>
                {(allDayByDay[key] || []).map((o) => (
                  <button key={o.renderKey} onClick={() => openEvent(o)} className="rounded px-1.5 text-left text-[10px] font-semibold truncate text-white"
                    style={{ background: ACCENTS[o.ev.color] || ACCENTS.blue }}>{o.ev.title}</button>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto relative">
        <div ref={gridBodyRef} className="flex relative" style={{ height: 24 * HOUR_H }}>
          <div style={{ width: 52 }} className="relative flex-shrink-0">
            {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
              <div key={h} className="absolute right-1.5 text-[10px]" style={{ top: h * HOUR_H - 6, color: T.dim }}>{toAmPm(h * 60)}</div>
            ))}
          </div>
          {days.map((d) => {
            const key = dateKey(d);
            const win = unionWindows(key);
            return (
              <div key={key} className="flex-1 relative border-l" style={{ borderColor: T.gridLine }}>
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} className="absolute left-0 right-0 border-t" style={{ top: h * HOUR_H, borderColor: T.gridLine }} />
                ))}
                {win ? (
                  <>
                    <div className="absolute left-0 right-0" style={{ top: 0, height: (win.start / 60) * HOUR_H, background: T.shade }} />
                    <div className="absolute left-0 right-0" style={{ top: (win.end / 60) * HOUR_H, bottom: 0, background: T.shade }} />
                  </>
                ) : <div className="absolute inset-0" style={{ background: T.shade }} />}
                <div className="absolute inset-0" onPointerDown={(e) => beginCreate(e, key)} />
                {(timedByDay[key] || []).map((o) => (
                  <EventBlock key={o.renderKey} occ={o} dragPreview={dragPreview} beginDrag={beginDrag} openEvent={openEvent} openMaps={openMaps} />
                ))}
                {(tasksByDay[key] || []).map((it) => (
                  <TaskBlock key={"task_" + it.task.id + (it.done ? "_done" : "")} item={it} dragPreview={dragPreview} beginDrag={beginDrag} openTask={openTask} toggleTask={toggleTask} />
                ))}
                {dragPreview && dragPreview.dispDate === key && <GhostBlock preview={dragPreview} />}
                {createPreview && createPreview.date === key && (
                  <div className="absolute left-0.5 right-1 rounded-lg pointer-events-none" style={{ top: (createPreview.start / 60) * HOUR_H, height: ((createPreview.end - createPreview.start) / 60) * HOUR_H, background: colorSet("blue", T.mode).bg, border: `1.5px dashed ${T.accent}`, zIndex: 5 }}>
                    <div className="text-[10px] px-1.5 pt-0.5 font-medium" style={{ color: colorSet("blue", T.mode).text }}>{toAmPm(createPreview.start)} – {toAmPm(createPreview.end)}</div>
                  </div>
                )}
                {sameDay(d, now) && (
                  <div className="absolute left-0 right-0 flex items-center pointer-events-none" style={{ top: (nowMin / 60) * HOUR_H, zIndex: 4 }}>
                    <div className="rounded-full" style={{ width: 7, height: 7, background: T.danger, marginLeft: -3 }} />
                    <div className="flex-1" style={{ height: 1.5, background: T.danger }} />
                  </div>
                )}
              </div>
            );
          })}
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
  const [now, setNow] = useState(new Date());
  const [view, setView] = useState("week");
  const [anchor, setAnchor] = useState(new Date());
  const [itemDraft, setItemDraft] = useState(null);
  const [showCats, setShowCats] = useState(false);
  const [quickTitle, setQuickTitle] = useState("");
  const [saveState, setSaveState] = useState("idle");
  const [dragPreview, setDragPreview] = useState(null);
  const [createPreview, setCreatePreview] = useState(null);
  const scrollRef = useRef(null);
  const gridBodyRef = useRef(null);
  const saveTimer = useRef(null);
  const dragRef = useRef(null);
  const skipNextSave = useRef(true);

  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30000); return () => clearInterval(t); }, []);
  useEffect(() => { initIdentity((u) => { setUser(u); setAuthReady(true); }); }, []);

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
        } else if (user) {
          const raw = localStorage.getItem(STORE_KEY);
          if (raw) {
            const m = migrate(JSON.parse(raw));
            setTasks(m.tasks); setEvents(m.events); setCategories(m.categories);
            saveData(user, m).catch(() => {});
          }
        }
      } catch { setSaveState("error"); }
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
        await saveData(user, { tasks, events, categories });
        setSaveState("saved");
        setTimeout(() => setSaveState("idle"), 1500);
      } catch { setSaveState("error"); }
    }, 500);
    return () => clearTimeout(saveTimer.current);
  }, [tasks, events, categories, loaded, user]);

  /* land on the current time; only view changes re-scroll */
  useEffect(() => {
    if (!loaded || (view !== "week" && view !== "day")) return;
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        const m = new Date();
        scrollRef.current.scrollTop = Math.max(0, ((m.getHours() * 60 + m.getMinutes()) / 60) * HOUR_H - 150);
      }
    });
  }, [view, loaded]);

  const nowMin = now.getHours() * 60 + now.getMinutes();

  const range = useMemo(() => {
    if (view === "month") {
      const gs = startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
      return { start: dateKey(gs), end: dateKey(addDays(gs, 41)) };
    }
    if (view === "week") {
      const ws = startOfWeek(anchor);
      return { start: dateKey(ws), end: dateKey(addDays(ws, 6)) };
    }
    return { start: dateKey(anchor), end: dateKey(anchor) };
  }, [view, anchor]);

  const occurrences = useMemo(() => expandOccurrences(events, range.start, range.end, deviceTz), [events, range]);
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
      if (s) (m[s.date] ||= []).push({ task: t, ...s, done: false });
    }
    return m;
  }, [tasks, schedule]);

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

  const openEvent = useCallback((occ) => { if (!dragRef.current?.moved) setItemDraft({ ...occ.ev, itemType: "event", occDate: occ.occDate }); }, []);
  const openTask = useCallback((t) => { if (!dragRef.current?.moved) setItemDraft({ ...t, itemType: "task" }); }, []);
  const openMaps = useCallback((loc) => window.open(`https://www.google.com/maps/search/?api=1&query=${loc.lat},${loc.lon}`, "_blank"), []);

  const days = useMemo(() => {
    if (view === "week") return Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor), i));
    if (view === "day") return [anchor];
    return [];
  }, [view, anchor]);

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
      s.minDelta = Math.round(dy / (HOUR_H / 60) / 15) * 15;
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
    const isTouch = e.pointerType === "touch";
    const rect = e.currentTarget.getBoundingClientRect();
    const yToMin = (clientY) => Math.max(0, Math.min(1440, Math.round(((clientY - rect.top) / HOUR_H) * 60 / 15) * 15));
    const anchorMin = yToMin(e.clientY);
    const st = { create: true, key, anchorMin, x0: e.clientX, y0: e.clientY, active: !isTouch, moved: false, timer: null, last: anchorMin };
    if (isTouch) st.timer = setTimeout(() => { st.active = true; if (navigator.vibrate) navigator.vibrate(15); }, 400);
    dragRef.current = st;

    const move = (ev) => {
      const s = dragRef.current;
      if (!s || !s.create) return;
      const dx = ev.clientX - s.x0, dy = ev.clientY - s.y0;
      if (!s.active) { if (Math.hypot(dx, dy) > 10) { clearTimeout(s.timer); cleanup(); } return; }
      ev.preventDefault();
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
        if (s.active) {
          if (s.moved) {
            const a = Math.min(s.anchorMin, s.last), b = Math.max(s.anchorMin, s.last);
            setItemDraft({ itemType: "event", fromGrid: true, date: key, start: a, end: Math.max(b, a + 15), color: "blue", tz: deviceTz });
          } else {
            const m = Math.floor(s.anchorMin / 30) * 30;
            setItemDraft({ itemType: "event", fromGrid: true, date: key, start: m, end: Math.min(m + 60, 1440), color: "blue", tz: deviceTz });
          }
        }
      }
      cleanup();
    };
    const cleanup = () => {
      dragRef.current = null;
      setCreatePreview(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }, []);

  const unionWindows = useCallback((key) => {
    const wins = categories.map((c) => windowFor(c, key)).filter(Boolean);
    if (!wins.length) return null;
    return { start: Math.min(...wins.map((w) => w.start)), end: Math.max(...wins.map((w) => w.end)) };
  }, [categories]);

  const shift = (dir) => {
    if (view === "month") { const d = new Date(anchor); d.setMonth(d.getMonth() + dir); setAnchor(d); }
    else setAnchor(addDays(anchor, dir * (view === "week" ? 7 : 1)));
  };

  const title = view === "month" ? `${MONTHS[anchor.getMonth()]} ${anchor.getFullYear()}`
    : view === "day" ? `${MONTHS[anchor.getMonth()]} ${anchor.getDate()}, ${anchor.getFullYear()}`
    : (() => { const ws = startOfWeek(anchor); const we = addDays(ws, 6);
        return ws.getMonth() === we.getMonth() ? `${MONTHS[ws.getMonth()]} ${ws.getFullYear()}` : `${MONTHS[ws.getMonth()].slice(0, 3)} – ${MONTHS[we.getMonth()].slice(0, 3)} ${we.getFullYear()}`; })();

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
      <style>{`.rl-hover:hover{background:${T.hover}} html{color-scheme:${mode}} ::-webkit-scrollbar{width:10px;height:10px} ::-webkit-scrollbar-thumb{background:${T.mode === "dark" ? "#3a3a3e" : "#c9c9ce"};border-radius:5px;border:2px solid ${T.surface}} ::-webkit-scrollbar-track{background:transparent}`}</style>
      <div className="h-screen flex" style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", background: T.bg, color: T.text, colorScheme: mode }}>
        {/* ---------- sidebar ---------- */}
        <div className="w-72 flex-shrink-0 flex flex-col border-r" style={{ borderColor: T.border, background: T.surface }}>
          <div className="px-4 pt-4 pb-2 flex items-center justify-between">
            <h2 className="font-bold text-lg flex items-center gap-1.5" style={{ color: T.text }}>
              <span aria-hidden="true" style={{ color: T.accent }}>↻</span>Rollover
            </h2>
            <span className="text-[10px]" style={{ color: saveState === "error" ? T.danger : T.faint }}>
              {saveState === "saving" ? (user ? "syncing…" : "saving…") : saveState === "saved" ? (user ? "synced" : "saved") : saveState === "error" ? "sync failed" : ""}
            </span>
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
            {user ? (
              <div className="flex items-center justify-between">
                <span className="text-[11px] truncate" style={{ color: T.dim }}>{user.email}</span>
                <button onClick={doLogout} className="text-xs font-medium" style={{ color: T.danger }}>Sign out</button>
              </div>
            ) : <button onClick={openLogin} className="text-xs font-medium text-left" style={{ color: T.accent }}>Sign in to sync across devices</button>}
          </div>
        </div>

        {/* ---------- calendar ---------- */}
        <div className="flex-1 flex flex-col min-w-0" style={{ background: T.surface }}>
          <div className="flex items-center gap-2 px-4 py-2.5 border-b" style={{ borderColor: T.border }}>
            <h1 className="font-bold text-lg mr-2" style={{ color: T.text }}>{title}</h1>
            <div className="flex rounded-lg overflow-hidden text-xs font-medium" style={{ background: T.surface2 }}>
              {["day", "week", "month"].map((v) => (
                <button key={v} onClick={() => setView(v)} className="px-3 py-1.5 capitalize"
                  style={{ background: view === v ? (T.mode === "dark" ? "#3a3a3e" : "white") : "transparent", color: view === v ? T.text : T.dim, boxShadow: view === v ? "0 1px 2px rgba(0,0,0,0.15)" : "none", borderRadius: 7, margin: 2 }}>{v}</button>
              ))}
            </div>
            <div className="flex-1" />
            <button onClick={() => setMode(mode === "dark" ? "light" : "dark")} className="px-2 py-1 text-sm rounded-md" style={{ color: T.dim }} title="Toggle dark mode" aria-label="Toggle dark mode">{mode === "dark" ? "☀" : "☾"}</button>
            <button onClick={() => shift(-1)} className="px-2 py-1 text-sm" style={{ color: T.accent }} aria-label="Previous">‹</button>
            <button onClick={() => setAnchor(new Date())} className="px-2.5 py-1 text-xs font-medium" style={{ color: T.accent }}>Today</button>
            <button onClick={() => shift(1)} className="px-2 py-1 text-sm" style={{ color: T.accent }} aria-label="Next">›</button>
            <button onClick={() => setItemDraft({ itemType: "event", date: dateKey(anchor), start: Math.min(Math.ceil(nowMin / 30) * 30, 23 * 60), end: Math.min(Math.ceil(nowMin / 30) * 30 + 60, 1440), color: "blue", tz: deviceTz })}
              className="ml-1 rounded-lg text-white font-semibold text-xs px-3 py-1.5" style={{ background: T.accent }}>＋ New</button>
          </div>

          {view === "month" ? (
            <MonthGrid anchor={anchor} now={now} allDayByDay={allDayByDay} timedByDay={timedByDay} tasksByDay={tasksByDay}
              onOpenDay={(d) => { setAnchor(d); setView("day"); }} />
          ) : (
            <TimeGrid days={days} now={now} nowMin={nowMin} allDayByDay={allDayByDay} timedByDay={timedByDay} tasksByDay={tasksByDay}
              unionWindows={unionWindows} scrollRef={scrollRef} gridBodyRef={gridBodyRef} dragPreview={dragPreview} createPreview={createPreview}
              beginDrag={beginDrag} beginCreate={beginCreate} openEvent={openEvent} openTask={openTask} toggleTask={toggleTask} openMaps={openMaps} />
          )}

          <div className="px-4 py-1.5 border-t flex items-center gap-3 text-[11px] flex-wrap" style={{ borderColor: T.border, color: T.dim }}>
            <span>Drag empty space to create · drag blocks to move · edges to resize · long-press on mobile</span>
            <span className="flex items-center gap-1"><span className="rounded-full" style={{ width: 7, height: 7, background: ACCENTS.red }} />High</span>
            <span className="flex items-center gap-1"><span className="rounded-full" style={{ width: 7, height: 7, background: ACCENTS.orange }} />Med</span>
            <span className="flex items-center gap-1"><span className="rounded-full" style={{ width: 7, height: 7, background: ACCENTS.blue }} />Low</span>
            <span className="flex items-center gap-1"><span style={{ color: T.ok }}>✓</span>done stays visible</span>
          </div>
        </div>

        {itemDraft && (
          <ItemModal draft={itemDraft} events={events} categories={categories}
            onSaveEvent={saveEvent} onSaveTask={saveTask}
            onDeleteSeries={deleteSeries} onDeleteOccurrence={deleteOccurrence} onDeleteTask={deleteTask}
            onClose={() => setItemDraft(null)} />
        )}
        {showCats && <CategoriesModal categories={categories} onSave={(cs) => { setCategories(cs); setShowCats(false); }} onClose={() => setShowCats(false)} />}
      </div>
    </ThemeCtx.Provider>
  );
}
