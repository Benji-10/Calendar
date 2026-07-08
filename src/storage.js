/* Storage layer: localStorage when signed out, Neon (via a Netlify
   Function) when signed in with Netlify Identity. Same data blob
   either way, so App.jsx doesn't care which one is active. */

import netlifyIdentity from "netlify-identity-widget";

export const STORE_KEY = "planner-data-v1";

export function initIdentity(onChange) {
  netlifyIdentity.on("login", (u) => { onChange(u); netlifyIdentity.close(); });
  netlifyIdentity.on("logout", () => onChange(null));
  netlifyIdentity.on("init", (u) => onChange(u || null));
  netlifyIdentity.init();
}
export const openLogin = () => netlifyIdentity.open();
export const doLogout = () => netlifyIdentity.logout();

async function bearer() {
  const u = netlifyIdentity.currentUser();
  if (!u) return null;
  const t = await u.jwt();
  return `Bearer ${t}`;
}

export async function loadData(user) {
  if (user) {
    const auth = await bearer();
    const r = await fetch("/.netlify/functions/data", { headers: { Authorization: auth } });
    if (!r.ok) throw new Error(`load failed (${r.status})`);
    const j = await r.json();
    return j.data || null;
  }
  const raw = localStorage.getItem(STORE_KEY);
  return raw ? JSON.parse(raw) : null;
}

export async function saveData(user, data) {
  if (user) {
    const auth = await bearer();
    const r = await fetch("/.netlify/functions/data", {
      method: "PUT",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ data }),
    });
    if (!r.ok) throw new Error(`sync failed (${r.status})`);
    return;
  }
  localStorage.setItem(STORE_KEY, JSON.stringify(data));
}
