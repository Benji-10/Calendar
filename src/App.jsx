import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import tzlookup from "tz-lookup";
import {
  pad, toAmPm, MONTHS, DOW, deviceTz,
  dateKey, parseKey, addDays, startOfWeek, sameDay,
  addDaysKey, dowOfKey, diffDaysKey,
  wallToUtc, utcToWall, timeZoneList, tzLabel,
} from "./time.js";
import { expandOccurrences, scheduleTasks, windowFor } from "./scheduler.js";
import { initIdentity, openLogin, doLogout, loadData, saveData, STORE_KEY } from "./storage.js";

const HOUR_H = 48;
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

const COLORS = {
  blue:   { bg: "#e8f1fe", border: "#0a84ff", text: "#0a5dc2" },
  red:    { bg: "#fdeaea", border: "#ff453a", text: "#c0332b" },
  orange: { bg: "#fef1e2", border: "#ff9f0a", text: "#b06400" },
  green:  { bg: "#e7f6ec", border: "#30d158", text: "#1b7d3a" },
  purple: { bg: "#f2ecfd", border: "#bf5af2", text: "#7d3ab3" },
  gray:   { bg: "#f0f0f2", border: "#8e8e93", text: "#5a5a5f" },
};
/* task tint follows priority: high fills first and reads hottest */
const PRIORITY = {
  1: { label: "High",   bg: "#fdeaea", border: "#ff453a", text: "#c0332b", dot: "#ff453a" },
  2: { label: "Medium", bg: "#fef1e2", border: "#ff9f0a", text: "#b06400", dot: "#ff9f0a" },
  3: { label: "Low",    bg: "#eef4ff", border: "#5b8def", text: "#3c66c4", dot: "#5b8def" },
};

const DEFAULT_CATEGORIES = [
  {
    id: "work", name: "Work",
    hours: { 0: null, 1: { start: 540, end: 1140 }, 2: { start: 540, end: 1140 }, 3: { start: 540, end: 1140 }, 4: { start: 540, end: 1140 }, 5: { start: 540, end: 1140 }, 6: null },
    overrides: {},
  },
  {
    id: "personal", name: "Personal",
    hours: { 0: { start: 600, end: 1320 }, 1: { start: 1140, end: 1320 }, 2: { start: 1140, end: 1320 }, 3: { start: 1140, end: 1320 }, 4: { start: 1140, end: 1320 }, 5: { start: 1140, end: 1320 }, 6: { start: 600, end: 1320 } },
    overrides: {},
  },
];

/* upgrade older saved blobs (single global work-hours) to categories */
function migrate(d) {
  const out = { tasks: d.tasks || [], events: d.events || [], categories: d.categories, settings: d.settings || {} };
  if (!out.categories) {
    const cats = JSON.parse(JSON.stringify(DEFAULT_CATEGORIES));
    if (d.settings && d.settings.workStart != null) {
      for (let i = 0; i < 7; i++) cats[0].hours[i] = (d.settings.days || [1, 2, 3, 4, 5]).includes(i) ? { start: d.settings.workStart, end: d.settings.workEnd } : null;
    }
    out.categories = cats;
  }
  out.tasks = out.tasks.map((t) => ({ category: "work", ...t }));
  out.events = out.events.map((e) => ({ tz: deviceTz, repeat: "none", allDay: false, exceptions: [], location: null, ...e }));
  return out;
}

/* ---------- atoms ---------- */
function TimeSelect({ value, onChange, from = 0, to = 24 * 60, step = 15, disabled }) {
  const opts = [];
  for (let m = from; m <= to; m += step) opts.push(m);
  return (
    <select value={value} onChange={(e) => onChange(Number(e.target.value))} disabled={disabled}
      className="border rounded-md px-2 py-1 text-sm bg-white disabled:opacity-40" style={{ borderColor: "#d9d9de" }}>
      {opts.map((m) => <option key={m} value={m}>{toAmPm(m)}</option>)}
    </select>
  );
}

function Check({ checked, onToggle, color = "#5b8def" }) {
  return (
    <button
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      className="flex-shrink-0 rounded-full flex items-center justify-center transition-all"
      style={{ width: 18, height: 18, border: `1.5px solid ${checked ? color : "#b8b8bf"}`, background: checked ? color : "transparent" }}
      aria-label={checked ? "Mark incomplete" : "Mark complete"}>
      {checked && (
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M2 5.2 L4.2 7.4 L8 2.8" stroke="white" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

function Modal({ title, onClose, children, footer, wide }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.25)" }} onClick={onClose}>
      <div className={`bg-white rounded-2xl shadow-2xl w-full ${wide ? "max-w-lg" : "max-w-sm"} max-h-full overflow-y-auto`} onClick={(e) => e.stopPropagation()}>
        <div className="px-5 pt-4 pb-2 flex items-center justify-between sticky top-0 bg-white rounded-t-2xl">
          <h3 className="font-semibold text-base" style={{ color: "#1c1c1e" }}>{title}</h3>
          <button onClick={onClose} className="text-sm" style={{ color: "#8e8e93" }}>✕</button>
        </div>
        <div className="px-5 pb-4">{children}</div>
        {footer && <div className="px-5 pb-4 flex gap-2 justify-end items-center flex-wrap">{footer}</div>}
      </div>
    </div>
  );
}

const Row = ({ label, children }) => (
  <div className="flex items-center gap-2">
    <span className="text-xs flex-shrink-0" style={{ color: "#8e8e93", width: 58 }}>{label}</span>
    {children}
  </div>
);

/* ---------- event editor ---------- */
function EventModal({ draft, events, onSave, onDeleteSeries, onDeleteOccurrence, onClose }) {
  const [title, setTitle] = useState(draft.title || "");
  const [date, setDate] = useState(draft.date);
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
  const [showSuggest, setShowSuggest] = useState(false);
  const locTimer = useRef(null);
  const isNew = !draft.id;

  /* title autosuggest: any past title used 3+ times */
  const suggestions = useMemo(() => {
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
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5)
      .map(([, v]) => v);
  }, [events, title]);

  const pickSuggestion = (s) => {
    const e = s.latest;
    setTitle(e.title);
    setColor(e.color || "blue");
    setAllDay(!!e.allDay);
    if (!e.allDay) { setStart(e.start); setEnd(e.end); }
    setTz(e.tz || deviceTz);
    setLocation(e.location || null);
    setShowSuggest(false);
  };

  /* location search (OpenStreetMap Nominatim — free, no key) */
  const searchLocation = (q) => {
    setLocQuery(q);
    clearTimeout(locTimer.current);
    if (q.trim().length < 3) { setLocResults([]); return; }
    locTimer.current = setTimeout(async () => {
      try {
        const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}`, { headers: { Accept: "application/json" } });
        if (r.ok) setLocResults(await r.json());
      } catch { setLocResults([]); }
    }, 450);
  };

  const pickLocation = (r) => {
    const name = r.display_name.split(",").slice(0, 2).join(",").trim();
    setLocation({ name, full: r.display_name, lat: +r.lat, lon: +r.lon });
    setLocQuery("");
    setLocResults([]);
    try {
      const suggested = tzlookup(+r.lat, +r.lon);
      if (suggested && suggested !== tz) { setTz(suggested); setTzFromLocation(true); }
    } catch { /* no tz for these coords */ }
  };

  const zones = useMemo(() => timeZoneList(), []);
  const localPreview = useMemo(() => {
    if (allDay || tz === deviceTz) return null;
    const utc = wallToUtc(date, start, tz);
    const w = utcToWall(utc, deviceTz);
    return `${w.date === date ? "" : w.date + " "}${toAmPm(w.minutes)} your time`;
  }, [date, start, tz, allDay]);

  const commit = () => {
    if (!title.trim()) return;
    onSave({
      exceptions: [], createdAt: Date.now(), ...draft,
      id: draft.id || uid(), title: title.trim(), date, allDay,
      start: allDay ? 0 : start, end: allDay ? 1440 : Math.max(end, start + 15),
      tz, color, location,
      repeat, repeatUntil: repeat !== "none" && repeatUntil ? repeatUntil : null,
    });
  };

  return (
    <Modal
      title={isNew ? "New Event" : "Edit Event"} onClose={onClose}
      footer={
        <>
          {!isNew && repeat !== "none" && draft.occDate && (
            <button onClick={() => onDeleteOccurrence(draft.id, draft.occDate)} className="px-2 py-1.5 rounded-lg text-xs font-medium" style={{ color: "#ff3b30" }}>Delete this day</button>
          )}
          {!isNew && (
            <button onClick={() => onDeleteSeries(draft.id)} className="px-2 py-1.5 rounded-lg text-xs font-medium" style={{ color: "#ff3b30" }}>{repeat !== "none" ? "Delete series" : "Delete"}</button>
          )}
          <div className="flex-1" />
          <button onClick={commit} className="px-4 py-1.5 rounded-lg text-sm font-semibold text-white" style={{ background: "#0a84ff" }}>{isNew ? "Add" : "Save"}</button>
        </>
      }>
      <div className="flex flex-col gap-3">
        <div className="relative">
          <input autoFocus value={title}
            onChange={(e) => { setTitle(e.target.value); setShowSuggest(true); }}
            onFocus={() => setShowSuggest(true)}
            onBlur={() => setTimeout(() => setShowSuggest(false), 150)}
            placeholder="Title"
            className="w-full rounded-lg px-3 py-2 text-sm"
            style={{ background: "#f2f2f7", border: "1px solid transparent", outline: "none" }} />
          {showSuggest && suggestions.length > 0 && (
            <div className="absolute left-0 right-0 mt-1 bg-white rounded-lg shadow-lg border z-10 overflow-hidden" style={{ borderColor: "#e5e5ea" }}>
              {suggestions.map((s) => (
                <button key={s.latest.id} onMouseDown={(e) => { e.preventDefault(); pickSuggestion(s); }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex items-center gap-2">
                  <span className="rounded-full flex-shrink-0" style={{ width: 8, height: 8, background: (COLORS[s.latest.color] || COLORS.blue).border }} />
                  <span className="flex-1 truncate">{s.latest.title}</span>
                  <span className="text-[10px]" style={{ color: "#8e8e93" }}>used {s.count}×</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <Row label="All-day">
          <button onClick={() => setAllDay(!allDay)} className="rounded-full relative transition-colors" style={{ width: 40, height: 24, background: allDay ? "#30d158" : "#d9d9de" }} aria-label="Toggle all-day">
            <span className="absolute top-0.5 rounded-full bg-white shadow transition-all" style={{ width: 20, height: 20, left: allDay ? 18 : 2 }} />
          </button>
        </Row>

        <Row label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="border rounded-md px-2 py-1 text-sm" style={{ borderColor: "#d9d9de" }} /></Row>
        {!allDay && (
          <>
            <Row label="Starts"><TimeSelect value={start} onChange={(v) => { setStart(v); if (end <= v) setEnd(Math.min(v + 60, 1440)); }} /></Row>
            <Row label="Ends"><TimeSelect value={end} onChange={setEnd} from={start + 15} /></Row>
            <Row label="Time zone">
              <div className="flex flex-col gap-0.5 min-w-0">
                <select value={tz} onChange={(e) => { setTz(e.target.value); setTzFromLocation(false); }} className="border rounded-md px-2 py-1 text-sm bg-white max-w-full" style={{ borderColor: "#d9d9de", maxWidth: 220 }}>
                  {!zones.includes(tz) && <option value={tz}>{tz}</option>}
                  {zones.map((z) => <option key={z} value={z}>{z}</option>)}
                </select>
                <span className="text-[10px]" style={{ color: "#8e8e93" }}>
                  {tzLabel(tz)}{tzFromLocation ? " · set from location" : ""}{localPreview ? ` · shows as ${localPreview}` : ""}
                </span>
              </div>
            </Row>
          </>
        )}

        <Row label="Repeat">
          <select value={repeat} onChange={(e) => setRepeat(e.target.value)} className="border rounded-md px-2 py-1 text-sm bg-white" style={{ borderColor: "#d9d9de" }}>
            <option value="none">Never</option><option value="daily">Every day</option><option value="weekdays">Weekdays</option>
            <option value="weekly">Every week</option><option value="monthly">Every month</option><option value="yearly">Every year</option>
          </select>
          {repeat !== "none" && (
            <input type="date" value={repeatUntil} onChange={(e) => setRepeatUntil(e.target.value)} title="Repeat until (optional)"
              className="border rounded-md px-2 py-1 text-xs" style={{ borderColor: "#d9d9de" }} />
          )}
        </Row>
        {repeat !== "none" && !isNew && <p className="text-[10px] -mt-2" style={{ color: "#8e8e93" }}>Changes apply to every occurrence in the series.</p>}

        <Row label="Location">
          <div className="flex-1 min-w-0">
            {location ? (
              <div className="flex items-center gap-2">
                <a href={`https://www.google.com/maps/search/?api=1&query=${location.lat},${location.lon}`} target="_blank" rel="noreferrer"
                  className="flex-1 truncate text-sm font-medium" style={{ color: "#0a84ff" }} title="Open in Google Maps">📍 {location.name}</a>
                <button onClick={() => setLocation(null)} className="text-xs px-1" style={{ color: "#8e8e93" }}>✕</button>
              </div>
            ) : (
              <div className="relative">
                <input value={locQuery} onChange={(e) => searchLocation(e.target.value)} placeholder="Search a place…"
                  className="w-full rounded-lg px-3 py-1.5 text-sm" style={{ background: "#f2f2f7", border: "1px solid transparent", outline: "none" }} />
                {locResults.length > 0 && (
                  <div className="absolute left-0 right-0 mt-1 bg-white rounded-lg shadow-lg border z-10 overflow-hidden" style={{ borderColor: "#e5e5ea" }}>
                    {locResults.map((r) => (
                      <button key={r.place_id} onMouseDown={(e) => { e.preventDefault(); pickLocation(r); }}
                        className="w-full text-left px-3 py-2 text-xs hover:bg-gray-50 truncate">{r.display_name}</button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </Row>

        <Row label="Color">
          <div className="flex gap-2">
            {Object.keys(COLORS).map((c) => (
              <button key={c} onClick={() => setColor(c)} className="rounded-full" aria-label={c}
                style={{ width: 20, height: 20, background: COLORS[c].border, outline: color === c ? `2px solid ${COLORS[c].border}` : "none", outlineOffset: 2 }} />
            ))}
          </div>
        </Row>
      </div>
    </Modal>
  );
}

/* ---------- categories / hours editor ---------- */
function CategoriesModal({ categories, onSave, onClose }) {
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
      footer={<button onClick={() => onSave(cats)} className="px-4 py-1.5 rounded-lg text-sm font-semibold text-white" style={{ background: "#0a84ff" }}>Save</button>}>
      <p className="text-xs mb-3" style={{ color: "#8e8e93" }}>
        Each task belongs to a category and only ever rolls over into that category's hours. Add a dated exception for holidays or one-off changes — Work skips weekends by default.
      </p>
      <div className="flex gap-1.5 mb-3 flex-wrap">
        {cats.map((c) => (
          <button key={c.id} onClick={() => setSel(c.id)} className="rounded-full text-xs font-medium px-3 py-1.5"
            style={{ background: sel === c.id ? "#0a84ff" : "#f2f2f7", color: sel === c.id ? "white" : "#5a5a5f" }}>{c.name}</button>
        ))}
        <button onClick={() => {
          const name = prompt("Category name");
          if (!name?.trim()) return;
          const id = uid();
          setCats((cs) => [...cs, { id, name: name.trim(), hours: { 0: null, 1: { start: 540, end: 1020 }, 2: { start: 540, end: 1020 }, 3: { start: 540, end: 1020 }, 4: { start: 540, end: 1020 }, 5: { start: 540, end: 1020 }, 6: null }, overrides: {} }]);
          setSel(id);
        }} className="rounded-full text-xs px-3 py-1.5" style={{ background: "#f2f2f7", color: "#0a84ff" }}>+ New</button>
      </div>

      {cat && (
        <>
          <div className="flex flex-col gap-1.5 mb-4">
            {DOW.map((d, i) => {
              const h = cat.hours[i];
              return (
                <div key={d} className="flex items-center gap-2">
                  <button onClick={() => patch((c) => { c.hours[i] = h ? null : { start: 540, end: 1140 }; return c; })}
                    className="rounded-full text-xs font-medium py-1" style={{ width: 44, background: h ? "#0a84ff" : "#f2f2f7", color: h ? "white" : "#8e8e93" }}>{d}</button>
                  {h ? (
                    <>
                      <TimeSelect value={h.start} onChange={(v) => patch((c) => { c.hours[i] = { start: v, end: Math.max(c.hours[i].end, v + 60) }; return c; })} />
                      <span className="text-xs" style={{ color: "#8e8e93" }}>to</span>
                      <TimeSelect value={h.end} onChange={(v) => patch((c) => { c.hours[i].end = v; return c; })} from={h.start + 60} />
                    </>
                  ) : (
                    <span className="text-xs" style={{ color: "#c7c7cc" }}>Off — nothing scheduled</span>
                  )}
                </div>
              );
            })}
          </div>

          <div className="text-[10px] uppercase tracking-wide mb-1" style={{ color: "#8e8e93" }}>Exceptions (holidays & one-offs)</div>
          {Object.entries(cat.overrides || {}).sort().map(([k, v]) => (
            <div key={k} className="flex items-center gap-2 text-xs py-1">
              <span className="font-medium" style={{ color: "#1c1c1e", width: 90 }}>{k}</span>
              <span style={{ color: v ? "#1b7d3a" : "#c0332b" }}>{v ? `${toAmPm(v.start)} – ${toAmPm(v.end)}` : "Off (holiday)"}</span>
              <button onClick={() => patch((c) => { delete c.overrides[k]; return c; })} className="px-1" style={{ color: "#8e8e93" }}>✕</button>
            </div>
          ))}
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <input type="date" value={ovDate} onChange={(e) => setOvDate(e.target.value)} className="border rounded-md px-2 py-1 text-xs" style={{ borderColor: "#d9d9de" }} />
            <button onClick={() => setOvOff(!ovOff)} className="rounded-full text-xs px-2.5 py-1" style={{ background: ovOff ? "#fdeaea" : "#e7f6ec", color: ovOff ? "#c0332b" : "#1b7d3a" }}>
              {ovOff ? "Off (holiday)" : "Custom hours"}
            </button>
            {!ovOff && (<><TimeSelect value={ovStart} onChange={setOvStart} /><span className="text-xs" style={{ color: "#8e8e93" }}>to</span><TimeSelect value={ovEnd} onChange={setOvEnd} from={ovStart + 60} /></>)}
            <button onClick={() => { if (!ovDate) return; patch((c) => { c.overrides[ovDate] = ovOff ? null : { start: ovStart, end: ovEnd }; return c; }); setOvDate(""); }}
              className="rounded-lg text-xs font-semibold text-white px-2.5 py-1" style={{ background: "#0a84ff" }}>Add</button>
          </div>
        </>
      )}
    </Modal>
  );
}

/* ==================================================================== */
export default function Planner() {
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [events, setEvents] = useState([]);
  const [categories, setCategories] = useState(DEFAULT_CATEGORIES);
  const [now, setNow] = useState(new Date());
  const [view, setView] = useState("week");
  const [anchor, setAnchor] = useState(new Date());
  const [eventDraft, setEventDraft] = useState(null);
  const [showCats, setShowCats] = useState(false);
  const [newTask, setNewTask] = useState({ title: "", duration: 60, deadline: "", priority: 2, category: "work" });
  const [saveState, setSaveState] = useState("idle");
  const [dragPreview, setDragPreview] = useState(null);
  const scrollRef = useRef(null);
  const gridBodyRef = useRef(null);
  const saveTimer = useRef(null);
  const dragRef = useRef(null);
  const suppressClick = useRef(false);
  const skipNextSave = useRef(true);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => { initIdentity((u) => { setUser(u); setAuthReady(true); }); }, []);

  /* load whenever auth state settles/changes */
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
          /* first sign-in on this account: seed the server with local data */
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

  /* save (debounced) */
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

  /* land on the current time — and stay there (only view changes rescroll) */
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

  /* visible range + occurrences */
  const range = useMemo(() => {
    if (view === "month") {
      const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      const gs = startOfWeek(first);
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
      if (t.done) continue;
      const s = schedule[t.id];
      if (s) (m[s.date] ||= []).push({ task: t, ...s });
    }
    return m;
  }, [tasks, schedule]);

  /* ---------- mutations ---------- */
  const toggleTask = (id) => setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, done: !t.done, completedAt: !t.done ? Date.now() : null } : t)));
  const deleteTask = (id) => setTasks((ts) => ts.filter((t) => t.id !== id));
  const addTask = () => {
    if (!newTask.title.trim()) return;
    setTasks((ts) => [...ts, { id: uid(), title: newTask.title.trim(), duration: newTask.duration, deadline: newTask.deadline || null, priority: newTask.priority, category: newTask.category, done: false, createdAt: Date.now() }]);
    setNewTask((p) => ({ ...p, title: "", deadline: "" }));
  };
  const saveEvent = (ev) => {
    setEvents((es) => {
      const i = es.findIndex((x) => x.id === ev.id);
      if (i === -1) return [...es, ev];
      const c = es.slice(); c[i] = ev; return c;
    });
    setEventDraft(null);
  };
  const deleteSeries = (id) => { setEvents((es) => es.filter((e) => e.id !== id)); setEventDraft(null); };
  const deleteOccurrence = (id, occDate) => {
    setEvents((es) => es.map((e) => (e.id === id ? { ...e, exceptions: [...(e.exceptions || []), occDate] } : e)));
    setEventDraft(null);
  };

  /* ---------- drag / resize (Apple-style) ---------- */
  const days = useMemo(() => {
    if (view === "week") return Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor), i));
    if (view === "day") return [anchor];
    return [];
  }, [view, anchor]);

  const beginDrag = useCallback((e, occ, mode) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.stopPropagation();
    const isTouch = e.pointerType === "touch";
    const st = { occ, mode, x0: e.clientX, y0: e.clientY, active: !isTouch, moved: false, dayDelta: 0, minDelta: 0, timer: null };
    if (isTouch) st.timer = setTimeout(() => { st.active = true; if (navigator.vibrate) navigator.vibrate(15); }, 400);
    dragRef.current = st;

    const move = (ev) => {
      const s = dragRef.current;
      if (!s) return;
      const dx = ev.clientX - s.x0, dy = ev.clientY - s.y0;
      if (!s.active) {
        if (Math.hypot(dx, dy) > 10) { clearTimeout(s.timer); cleanup(); }
        return;
      }
      ev.preventDefault();
      if (Math.hypot(dx, dy) > 5) s.moved = true;
      if (!s.moved) return;
      s.minDelta = Math.round(dy / (HOUR_H / 60) / 15) * 15;
      if (s.mode === "move" && gridBodyRef.current && days.length > 1) {
        const colW = (gridBodyRef.current.getBoundingClientRect().width - 52) / days.length;
        s.dayDelta = Math.round(dx / colW);
      } else s.dayDelta = 0;
      const o = s.occ;
      let p;
      if (s.mode === "move") {
        const dur = o.dispEnd - o.dispStart;
        const start = Math.min(Math.max(o.dispStart + s.minDelta, 0), 1440 - Math.min(dur, 1440));
        p = { renderKey: o.renderKey, dispDate: addDaysKey(o.dispDate, s.dayDelta), dispStart: start, dispEnd: start + dur };
      } else if (s.mode === "resize-end") {
        p = { renderKey: o.renderKey, dispDate: o.dispDate, dispStart: o.dispStart, dispEnd: Math.max(o.dispStart + 15, o.dispEnd + s.minDelta) };
      } else {
        p = { renderKey: o.renderKey, dispDate: o.dispDate, dispStart: Math.min(o.dispEnd - 15, Math.max(0, o.dispStart + s.minDelta)), dispEnd: o.dispEnd };
      }
      s.preview = p;
      setDragPreview(p);
    };
    const up = () => {
      const s = dragRef.current;
      if (s) {
        clearTimeout(s.timer);
        if (s.active && s.moved && s.preview) {
          suppressClick.current = true;
          commitDrag(s);
          setTimeout(() => { suppressClick.current = false; }, 50);
        }
      }
      cleanup();
    };
    const cleanup = () => {
      dragRef.current = null;
      setDragPreview(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }, [days]);

  const commitDrag = (s) => {
    const { occ, mode, dayDelta, minDelta } = s;
    setEvents((es) => es.map((ev) => {
      if (ev.id !== occ.ev.id) return ev;
      let startUtc = occ.startUtc, endUtc = occ.endUtc;
      if (mode === "move") { const d = (dayDelta * 1440 + minDelta) * 60000; startUtc += d; endUtc += d; }
      else if (mode === "resize-end") endUtc = Math.max(startUtc + 15 * 60000, endUtc + minDelta * 60000);
      else startUtc = Math.min(endUtc - 15 * 60000, startUtc + minDelta * 60000);
      const w = utcToWall(startUtc, ev.tz);
      const dur = Math.round((endUtc - startUtc) / 60000);
      if (!ev.repeat || ev.repeat === "none") return { ...ev, date: w.date, start: w.minutes, end: w.minutes + dur };
      /* repeating series: shift the base date by the same day offset, keep new wall time */
      const shift = diffDaysKey(w.date, occ.occDate);
      return { ...ev, date: addDaysKey(ev.date, shift), start: w.minutes, end: w.minutes + dur };
    }));
  };

  /* union of category windows -> downtime shading */
  const unionWindows = useCallback((key) => {
    const wins = categories.map((c) => windowFor(c, key)).filter(Boolean);
    if (!wins.length) return null;
    return { start: Math.min(...wins.map((w) => w.start)), end: Math.max(...wins.map((w) => w.end)) };
  }, [categories]);

  const openMaps = (loc) => window.open(`https://www.google.com/maps/search/?api=1&query=${loc.lat},${loc.lon}`, "_blank");

  /* ---------- calendar blocks ---------- */
  const EventBlock = ({ occ }) => {
    const isPrev = dragPreview && dragPreview.renderKey === occ.renderKey;
    const start = isPrev ? dragPreview.dispStart : occ.dispStart;
    const end = isPrev ? dragPreview.dispEnd : occ.dispEnd;
    const c = COLORS[occ.ev.color] || COLORS.blue;
    const clippedEnd = Math.min(end, 1440);
    return (
      <div
        className="absolute left-0.5 right-1 rounded-md overflow-hidden cursor-grab active:cursor-grabbing select-none group/ev"
        onPointerDown={(e) => beginDrag(e, occ, "move")}
        onClick={() => { if (!suppressClick.current) setEventDraft({ ...occ.ev, occDate: occ.occDate }); }}
        style={{
          top: (start / 60) * HOUR_H, height: Math.max(((clippedEnd - start) / 60) * HOUR_H - 2, 18),
          background: c.bg, borderLeft: `3px solid ${c.border}`, zIndex: isPrev ? 5 : 2,
          opacity: isPrev ? 0.85 : 1, boxShadow: isPrev ? "0 4px 12px rgba(0,0,0,0.2)" : "none",
          touchAction: "none",
        }}>
        <div className="px-1.5 py-0.5 pointer-events-none">
          <div className="text-xs font-semibold truncate" style={{ color: c.text }}>
            {occ.ev.repeat && occ.ev.repeat !== "none" ? "↻ " : ""}{occ.ev.title}
          </div>
          {clippedEnd - start >= 40 && (
            <div className="text-[10px] truncate" style={{ color: c.text, opacity: 0.75 }}>
              {toAmPm(start)} – {toAmPm(end % 1440)}{end > 1440 ? " ⁺¹" : ""}{occ.ev.tz !== deviceTz ? ` · ${tzLabel(occ.ev.tz, occ.startUtc)}` : ""}
            </div>
          )}
          {clippedEnd - start >= 64 && occ.ev.location && (
            <div className="text-[10px] truncate pointer-events-auto cursor-pointer" style={{ color: c.text, opacity: 0.75 }}
              onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); openMaps(occ.ev.location); }}>
              📍 {occ.ev.location.name}
            </div>
          )}
        </div>
        {/* resize handles, shown on hover like Apple Calendar */}
        <div className="absolute left-0 right-0 top-0 h-2 opacity-0 group-hover/ev:opacity-100 cursor-row-resize flex justify-center"
          onPointerDown={(e) => beginDrag(e, occ, "resize-start")} style={{ touchAction: "none" }}>
          <div className="rounded-full mt-0.5" style={{ width: 24, height: 3, background: c.border, opacity: 0.6 }} />
        </div>
        <div className="absolute left-0 right-0 bottom-0 h-2 opacity-0 group-hover/ev:opacity-100 cursor-row-resize flex justify-center items-end"
          onPointerDown={(e) => beginDrag(e, occ, "resize-end")} style={{ touchAction: "none" }}>
          <div className="rounded-full mb-0.5" style={{ width: 24, height: 3, background: c.border, opacity: 0.6 }} />
        </div>
      </div>
    );
  };

  const TaskBlock = ({ item }) => {
    const t = item.task;
    const p = PRIORITY[t.priority] || PRIORITY[3];
    const overdue = t.deadline && item.date > t.deadline;
    return (
      <div className="absolute left-0.5 right-1 rounded-md px-1.5 py-0.5 overflow-hidden"
        style={{ top: (item.start / 60) * HOUR_H, height: Math.max(((item.end - item.start) / 60) * HOUR_H - 2, 18), background: p.bg, borderLeft: `3px dashed ${overdue ? "#ff453a" : p.border}`, zIndex: 2 }}
        title={`Auto-scheduled · ${p.label} priority · rolls forward until checked off`}>
        <div className="flex items-start gap-1">
          <div className="mt-0.5"><Check checked={false} onToggle={() => toggleTask(t.id)} color={p.border} /></div>
          <div className="min-w-0">
            <div className="text-xs font-semibold truncate" style={{ color: p.text }}>{t.title}</div>
            {item.end - item.start >= 40 && (
              <div className="text-[10px] truncate" style={{ color: p.text, opacity: 0.75 }}>
                {toAmPm(item.start)} – {toAmPm(item.end)}{overdue ? " · past deadline" : ""}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  /* ---------- week / day grid ---------- */
  const TimeGrid = () => (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="border-b" style={{ borderColor: "#e5e5ea" }}>
        <div className="flex">
          <div style={{ width: 52 }} />
          {days.map((d) => {
            const isToday = sameDay(d, now);
            return (
              <div key={dateKey(d)} className="flex-1 text-center pt-1.5">
                <div className="text-[10px] uppercase tracking-wide" style={{ color: "#8e8e93" }}>{DOW[d.getDay()]}</div>
                <div className="text-sm font-semibold inline-flex items-center justify-center rounded-full"
                  style={{ width: 26, height: 26, background: isToday ? "#ff3b30" : "transparent", color: isToday ? "white" : "#1c1c1e" }}>{d.getDate()}</div>
              </div>
            );
          })}
        </div>
        {/* all-day row */}
        <div className="flex" style={{ minHeight: 22 }}>
          <div style={{ width: 52 }} className="text-[9px] text-right pr-1.5 pt-0.5" >
            <span style={{ color: "#c7c7cc" }}>all-day</span>
          </div>
          {days.map((d) => {
            const key = dateKey(d);
            return (
              <div key={key} className="flex-1 px-0.5 pb-1 flex flex-col gap-0.5 border-l" style={{ borderColor: "#ececf0" }}>
                {(allDayByDay[key] || []).map((o) => {
                  const c = COLORS[o.ev.color] || COLORS.blue;
                  return (
                    <button key={o.renderKey} onClick={() => setEventDraft({ ...o.ev, occDate: o.occDate })}
                      className="rounded px-1.5 text-left text-[10px] font-semibold truncate"
                      style={{ background: c.border, color: "white" }}>{o.ev.title}</button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto relative">
        <div ref={gridBodyRef} className="flex relative" style={{ height: 24 * HOUR_H }}>
          <div style={{ width: 52 }} className="relative flex-shrink-0">
            {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
              <div key={h} className="absolute right-1.5 text-[10px]" style={{ top: h * HOUR_H - 6, color: "#8e8e93" }}>{toAmPm(h * 60)}</div>
            ))}
          </div>
          {days.map((d) => {
            const key = dateKey(d);
            const win = unionWindows(key);
            return (
              <div key={key} className="flex-1 relative border-l" style={{ borderColor: "#ececf0" }}>
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} className="absolute left-0 right-0 border-t" style={{ top: h * HOUR_H, borderColor: "#ececf0" }} />
                ))}
                {win ? (
                  <>
                    <div className="absolute left-0 right-0" style={{ top: 0, height: (win.start / 60) * HOUR_H, background: "#f7f7f9" }} />
                    <div className="absolute left-0 right-0" style={{ top: (win.end / 60) * HOUR_H, bottom: 0, background: "#f7f7f9" }} />
                  </>
                ) : (
                  <div className="absolute inset-0" style={{ background: "#f7f7f9" }} />
                )}
                <div className="absolute inset-0" onClick={(e) => {
                  if (suppressClick.current) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const m = Math.floor(((e.clientY - rect.top) / HOUR_H) * 60 / 30) * 30;
                  setEventDraft({ date: key, start: m, end: Math.min(m + 60, 1440), color: "blue", tz: deviceTz });
                }} />
                {(timedByDay[key] || []).map((o) => <EventBlock key={o.renderKey} occ={o} />)}
                {dragPreview && dragPreview.dispDate === key && !(timedByDay[key] || []).some((o) => o.renderKey === dragPreview.renderKey) && (() => {
                  const src = occurrences.find((o) => o.renderKey === dragPreview.renderKey);
                  return src ? <EventBlock occ={{ ...src, dispDate: key }} /> : null;
                })()}
                {(tasksByDay[key] || []).map((it) => <TaskBlock key={it.task.id} item={it} />)}
                {sameDay(d, now) && (
                  <div className="absolute left-0 right-0 flex items-center pointer-events-none" style={{ top: (nowMin / 60) * HOUR_H, zIndex: 4 }}>
                    <div className="rounded-full" style={{ width: 7, height: 7, background: "#ff3b30", marginLeft: -3 }} />
                    <div className="flex-1" style={{ height: 1.5, background: "#ff3b30" }} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );

  /* ---------- month grid ---------- */
  const MonthGrid = () => {
    const gs = startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
    const cells = Array.from({ length: 42 }, (_, i) => addDays(gs, i));
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <div className="grid grid-cols-7 border-b" style={{ borderColor: "#e5e5ea" }}>
          {DOW.map((d) => <div key={d} className="text-center text-[10px] uppercase tracking-wide py-1" style={{ color: "#8e8e93" }}>{d}</div>)}
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
                style={{ borderColor: "#ececf0", background: inMonth ? "white" : "#fafafa" }}
                onClick={() => { setAnchor(d); setView("day"); }}>
                <div className="text-xs font-medium inline-flex items-center justify-center rounded-full mb-0.5"
                  style={{ width: 20, height: 20, background: isToday ? "#ff3b30" : "transparent", color: isToday ? "white" : inMonth ? "#1c1c1e" : "#c7c7cc" }}>{d.getDate()}</div>
                {items.slice(0, 3).map((x, i) => {
                  if (x.kind === "allday") {
                    const c = COLORS[x.o.ev.color] || COLORS.blue;
                    return <div key={i} className="truncate rounded px-1 mb-0.5 text-[10px] font-semibold text-white" style={{ background: c.border }}>{x.o.ev.title}</div>;
                  }
                  if (x.kind === "event") {
                    const c = COLORS[x.o.ev.color] || COLORS.blue;
                    return <div key={i} className="truncate rounded px-1 mb-0.5 text-[10px] font-medium" style={{ background: c.bg, color: c.text }}>{x.o.ev.title}</div>;
                  }
                  const p = PRIORITY[x.it.task.priority] || PRIORITY[3];
                  return <div key={i} className="truncate rounded px-1 mb-0.5 text-[10px] font-medium" style={{ background: p.bg, color: p.text }}>◌ {x.it.task.title}</div>;
                })}
                {items.length > 3 && <div className="text-[10px]" style={{ color: "#8e8e93" }}>+{items.length - 3} more</div>}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const shift = (dir) => {
    if (view === "month") { const d = new Date(anchor); d.setMonth(d.getMonth() + dir); setAnchor(d); }
    else setAnchor(addDays(anchor, dir * (view === "week" ? 7 : 1)));
  };

  const title = view === "month" ? `${MONTHS[anchor.getMonth()]} ${anchor.getFullYear()}`
    : view === "day" ? `${MONTHS[anchor.getMonth()]} ${anchor.getDate()}, ${anchor.getFullYear()}`
    : (() => { const ws = startOfWeek(anchor); const we = addDays(ws, 6);
        return ws.getMonth() === we.getMonth() ? `${MONTHS[ws.getMonth()]} ${ws.getFullYear()}` : `${MONTHS[ws.getMonth()].slice(0, 3)} – ${MONTHS[we.getMonth()].slice(0, 3)} ${we.getFullYear()}`; })();

  const pendingTasks = tasks.filter((t) => !t.done);
  const doneTasks = tasks.filter((t) => t.done).sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
  const catName = (id) => categories.find((c) => c.id === id)?.name || "—";

  if (!loaded) {
    return <div className="h-screen flex items-center justify-center text-sm" style={{ color: "#8e8e93", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }}>Loading Rollover…</div>;
  }

  return (
    <div className="h-screen flex" style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", background: "#f2f2f7" }}>
      {/* ---------- sidebar ---------- */}
      <div className="w-72 flex-shrink-0 flex flex-col border-r bg-white" style={{ borderColor: "#e5e5ea" }}>
        <div className="px-4 pt-4 pb-2 flex items-center justify-between">
          <h2 className="font-bold text-lg flex items-center gap-1.5" style={{ color: "#1c1c1e" }}>
            <span aria-hidden="true" style={{ color: "#0a84ff" }}>↻</span>Rollover
          </h2>
          <span className="text-[10px]" style={{ color: saveState === "error" ? "#ff3b30" : "#c7c7cc" }}>
            {saveState === "saving" ? (user ? "syncing…" : "saving…") : saveState === "saved" ? (user ? "synced" : "saved") : saveState === "error" ? "sync failed" : ""}
          </span>
        </div>

        <div className="px-4 pb-3">
          <input value={newTask.title} onChange={(e) => setNewTask((p) => ({ ...p, title: e.target.value }))}
            onKeyDown={(e) => e.key === "Enter" && addTask()} placeholder="New task…"
            className="w-full rounded-lg px-3 py-2 text-sm mb-2" style={{ background: "#f2f2f7", border: "1px solid transparent", outline: "none" }} />
          <div className="flex gap-1.5 items-center flex-wrap">
            <select value={newTask.duration} onChange={(e) => setNewTask((p) => ({ ...p, duration: Number(e.target.value) }))}
              className="border rounded-md px-1.5 py-1 text-xs bg-white" style={{ borderColor: "#d9d9de" }}>
              {[15, 30, 45, 60, 90, 120, 180, 240].map((m) => <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} hr${m > 60 ? "s" : ""}`}</option>)}
            </select>
            <select value={newTask.priority} onChange={(e) => setNewTask((p) => ({ ...p, priority: Number(e.target.value) }))}
              className="border rounded-md px-1.5 py-1 text-xs bg-white" style={{ borderColor: "#d9d9de", color: PRIORITY[newTask.priority].dot }}>
              <option value={1}>● High</option><option value={2}>● Med</option><option value={3}>● Low</option>
            </select>
            <select value={newTask.category} onChange={(e) => setNewTask((p) => ({ ...p, category: e.target.value }))}
              className="border rounded-md px-1.5 py-1 text-xs bg-white flex-1" style={{ borderColor: "#d9d9de" }}>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <input type="date" value={newTask.deadline} onChange={(e) => setNewTask((p) => ({ ...p, deadline: e.target.value }))}
              className="border rounded-md px-1 py-1 text-xs bg-white" style={{ borderColor: "#d9d9de", width: 118 }} title="Deadline (optional)" />
            <button onClick={addTask} className="rounded-lg text-white font-bold text-sm px-2.5 py-1" style={{ background: "#0a84ff" }}>+</button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-2">
          {pendingTasks.length === 0 && (
            <p className="text-xs text-center mt-6 px-4" style={{ color: "#8e8e93" }}>No tasks yet. Add one above — high priority fills your free slots first.</p>
          )}
          {pendingTasks.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt).map((t) => {
            const slot = schedule[t.id];
            const p = PRIORITY[t.priority] || PRIORITY[3];
            const overdue = slot && t.deadline && slot.date > t.deadline;
            return (
              <div key={t.id} className="group flex items-start gap-2 px-2 py-2 rounded-lg hover:bg-gray-50">
                <div className="mt-0.5"><Check checked={false} onToggle={() => toggleTask(t.id)} color={p.dot} /></div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate flex items-center gap-1.5" style={{ color: "#1c1c1e" }}>
                    <span className="rounded-full flex-shrink-0" style={{ width: 6, height: 6, background: p.dot }} />{t.title}
                  </div>
                  <div className="text-[11px]" style={{ color: overdue ? "#ff3b30" : "#8e8e93" }}>
                    {slot
                      ? `${sameDay(parseKey(slot.date), now) ? "Today" : `${DOW[dowOfKey(slot.date)]} ${+slot.date.slice(8)}`} · ${toAmPm(slot.start)}`
                      : "No slot in next 4 weeks"}
                    {" · "}{t.duration < 60 ? `${t.duration}m` : `${t.duration / 60}h`} · {catName(t.category)}{overdue ? " · past deadline" : ""}
                  </div>
                </div>
                <button onClick={() => deleteTask(t.id)} className="opacity-0 group-hover:opacity-100 text-xs px-1" style={{ color: "#c7c7cc" }} aria-label="Delete task">✕</button>
              </div>
            );
          })}
          {doneTasks.length > 0 && (
            <>
              <div className="text-[10px] uppercase tracking-wide px-2 mt-3 mb-1" style={{ color: "#8e8e93" }}>Completed</div>
              {doneTasks.slice(0, 15).map((t) => (
                <div key={t.id} className="group flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-50">
                  <Check checked onToggle={() => toggleTask(t.id)} color="#30d158" />
                  <div className="flex-1 text-sm truncate line-through" style={{ color: "#b8b8bf" }}>{t.title}</div>
                  <button onClick={() => deleteTask(t.id)} className="opacity-0 group-hover:opacity-100 text-xs px-1" style={{ color: "#c7c7cc" }} aria-label="Delete task">✕</button>
                </div>
              ))}
            </>
          )}
        </div>

        <div className="px-4 py-3 border-t flex flex-col gap-1.5" style={{ borderColor: "#e5e5ea" }}>
          <button onClick={() => setShowCats(true)} className="text-xs font-medium text-left" style={{ color: "#0a84ff" }}>⚙ Hours & categories</button>
          {user ? (
            <div className="flex items-center justify-between">
              <span className="text-[11px] truncate" style={{ color: "#8e8e93" }}>{user.email}</span>
              <button onClick={doLogout} className="text-xs font-medium" style={{ color: "#ff3b30" }}>Sign out</button>
            </div>
          ) : (
            <button onClick={openLogin} className="text-xs font-medium text-left" style={{ color: "#0a84ff" }}>Sign in to sync across devices</button>
          )}
        </div>
      </div>

      {/* ---------- calendar ---------- */}
      <div className="flex-1 flex flex-col min-w-0 bg-white">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b" style={{ borderColor: "#e5e5ea" }}>
          <h1 className="font-bold text-lg mr-2" style={{ color: "#1c1c1e" }}>{title}</h1>
          <div className="flex rounded-lg overflow-hidden text-xs font-medium" style={{ background: "#f2f2f7" }}>
            {["day", "week", "month"].map((v) => (
              <button key={v} onClick={() => setView(v)} className="px-3 py-1.5 capitalize"
                style={{ background: view === v ? "white" : "transparent", color: view === v ? "#1c1c1e" : "#8e8e93", boxShadow: view === v ? "0 1px 2px rgba(0,0,0,0.08)" : "none", borderRadius: 7, margin: 2 }}>{v}</button>
            ))}
          </div>
          <div className="flex-1" />
          <button onClick={() => shift(-1)} className="px-2 py-1 text-sm" style={{ color: "#0a84ff" }} aria-label="Previous">‹</button>
          <button onClick={() => setAnchor(new Date())} className="px-2.5 py-1 text-xs font-medium" style={{ color: "#0a84ff" }}>Today</button>
          <button onClick={() => shift(1)} className="px-2 py-1 text-sm" style={{ color: "#0a84ff" }} aria-label="Next">›</button>
          <button onClick={() => setEventDraft({ date: dateKey(anchor), start: Math.min(Math.ceil(nowMin / 30) * 30, 23 * 60), end: Math.min(Math.ceil(nowMin / 30) * 30 + 60, 1440), color: "blue", tz: deviceTz })}
            className="ml-1 rounded-lg text-white font-semibold text-xs px-3 py-1.5" style={{ background: "#0a84ff" }}>+ Event</button>
        </div>

        {view === "month" ? <MonthGrid /> : <TimeGrid />}

        <div className="px-4 py-1.5 border-t flex items-center gap-3 text-[11px] flex-wrap" style={{ borderColor: "#e5e5ea", color: "#8e8e93" }}>
          <span>Drag events to move · pull the edges to resize (long-press on mobile)</span>
          <span className="flex items-center gap-1"><span className="rounded-full" style={{ width: 7, height: 7, background: PRIORITY[1].dot }} />High</span>
          <span className="flex items-center gap-1"><span className="rounded-full" style={{ width: 7, height: 7, background: PRIORITY[2].dot }} />Med</span>
          <span className="flex items-center gap-1"><span className="rounded-full" style={{ width: 7, height: 7, background: PRIORITY[3].dot }} />Low — tasks auto-place in priority order</span>
        </div>
      </div>

      {eventDraft && <EventModal draft={eventDraft} events={events} onSave={saveEvent} onDeleteSeries={deleteSeries} onDeleteOccurrence={deleteOccurrence} onClose={() => setEventDraft(null)} />}
      {showCats && <CategoriesModal categories={categories} onSave={(cs) => { setCategories(cs); setShowCats(false); }} onClose={() => setShowCats(false)} />}
    </div>
  );
}
