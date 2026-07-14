/* Storage layer: localStorage when signed out, Neon (via a Netlify
   Function) when signed in with Netlify Identity. Same data blob
   either way, so App.jsx doesn't care which one is active. */

import netlifyIdentity from "netlify-identity-widget";

export const STORE_KEY = "planner-data-v1";
export const BACKUP_KEY = "planner-data-backup-v1";

export function initIdentity(onChange, onWidgetToggle) {
  if (onWidgetToggle) {
    netlifyIdentity.on("open", () => onWidgetToggle(true));
    netlifyIdentity.on("close", () => onWidgetToggle(false));
  }
  let settled = false;
  const settle = (u) => { settled = true; onChange(u); };
  netlifyIdentity.on("login", (u) => { settle(u); netlifyIdentity.close(); });
  netlifyIdentity.on("logout", () => onChange(null));
  netlifyIdentity.on("init", (u) => settle(u || null));
  netlifyIdentity.on("error", () => { if (!settled) settle(null); });
  try {
    netlifyIdentity.init();
  } catch {
    settle(null);
  }
  /* If Identity can't reach its backend (not yet enabled, offline, blocked),
     the "init" event may never fire — don't hang the app on the loading
     screen; fall back to signed-out (localStorage) mode. */
  setTimeout(() => { if (!settled) settle(netlifyIdentity.currentUser() || null); }, 2500);
}
export const openLogin = () => netlifyIdentity.open();
export const closeLogin = () => netlifyIdentity.close();

/* email-to-event suggestions */
export async function getAuthHeader() { return bearer(); }

export async function fetchEmailInbox(user) {
  if (!user) return null;
  const auth = await bearer();
  const r = await fetchT("/.netlify/functions/email", { headers: { Authorization: auth } });
  if (!r.ok) throw new Error(`email inbox failed (${r.status})`);
  return r.json();
}
export async function actOnSuggestion(user, id, action) {
  if (!user) return;
  const auth = await bearer();
  const r = await fetchT("/.netlify/functions/email", {
    method: "PUT",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ id, action }),
  });
  if (!r.ok) throw new Error(`suggestion update failed (${r.status})`);
}
export const doLogout = () => netlifyIdentity.logout();

/* Mobile networks stall silently; a request with no deadline means the UI
   says "syncing" forever. Everything network gets a hard timeout instead. */
const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))]);

const fetchT = async (url, opts = {}, ms = 12000) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e.name === "AbortError") throw new Error("request timed out");
    throw e;
  } finally {
    clearTimeout(t);
  }
};

async function bearer() {
  const u = netlifyIdentity.currentUser();
  if (!u) return null;
  const t = await withTimeout(u.jwt(), 10000, "auth refresh");
  return `Bearer ${t}`;
}

export async function loadData(user) {
  if (user) {
    const auth = await bearer();
    const r = await fetchT("/.netlify/functions/data", { headers: { Authorization: auth } });
    if (!r.ok) throw new Error(`load failed (${r.status})`);
    const j = await r.json();
    if (j.data) {
      try {
        const next = JSON.stringify(j.data);
        const cur = localStorage.getItem(STORE_KEY);
        /* about to overwrite different local data with the remote copy —
           keep the old local data as a backup so nothing is ever one
           overwrite away from gone */
        if (cur && cur !== next) localStorage.setItem(BACKUP_KEY, cur);
        localStorage.setItem(STORE_KEY, next);
      } catch { /* quota */ }
    }
    return j.data || null;
  }
  const raw = localStorage.getItem(STORE_KEY);
  return raw ? JSON.parse(raw) : null;
}

export async function saveData(user, data) {
  /* the local mirror is written first, unconditionally — whatever happens to
     the network, this device never loses what you just did */
  try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch { /* quota */ }
  if (user) {
    const auth = await bearer();
    const r = await fetchT("/.netlify/functions/data", {
      method: "PUT",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ data }),
    });
    if (!r.ok) throw new Error(`sync failed (${r.status})`);
  }
}
