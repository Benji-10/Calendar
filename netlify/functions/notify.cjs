/* Push notification plumbing (authenticated app calls + public key).
   - GET                      -> { publicKey } (VAPID public key — it's public)
   - POST (JWT) { sub }       -> save this browser's push subscription
   - POST (JWT) { schedule }  -> upload the next-48h occurrence times this
                                 device computed (the client owns repeat/tz
                                 logic; the cron only compares timestamps)
   - DELETE (JWT) { endpoint }-> remove a subscription
   Env: DATABASE_URL, VAPID_PUBLIC_KEY. */

const { neon } = require("@neondatabase/serverless");

let ensured = null;
async function ensureTables(sql) {
  if (!ensured) {
    ensured = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS planner_push (
        endpoint text PRIMARY KEY,
        user_id text NOT NULL,
        sub jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now())`;
      await sql`CREATE INDEX IF NOT EXISTS planner_push_user ON planner_push (user_id)`;
      await sql`CREATE TABLE IF NOT EXISTS planner_upcoming (
        user_id text PRIMARY KEY,
        data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now())`;
      await sql`CREATE TABLE IF NOT EXISTS planner_notif_log (
        key text PRIMARY KEY,
        sent_at timestamptz NOT NULL DEFAULT now())`;
    })();
  }
  await ensured;
}
const json = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

exports.handler = async (event, context) => {
  try {
    if (event.httpMethod === "GET") {
      if (!process.env.VAPID_PUBLIC_KEY) return json(200, { unconfigured: true });
      return json(200, { publicKey: process.env.VAPID_PUBLIC_KEY });
    }
    if (!process.env.DATABASE_URL) return json(500, { error: "DATABASE_URL not configured" });
    const user = context.clientContext && context.clientContext.user;
    if (!user) return json(401, { error: "Not signed in" });
    const sql = neon(process.env.DATABASE_URL);
    await ensureTables(sql);
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "bad json" }); }

    if (event.httpMethod === "POST" && body.sub && body.sub.endpoint) {
      await sql`INSERT INTO planner_push (endpoint, user_id, sub) VALUES (${body.sub.endpoint}, ${user.sub}, ${JSON.stringify(body.sub)}::jsonb)
                ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, sub = EXCLUDED.sub`;
      return json(200, { ok: true });
    }
    if (event.httpMethod === "POST" && Array.isArray(body.schedule)) {
      const clean = body.schedule.slice(0, 200).map((x) => ({
        key: String(x.key).slice(0, 200), title: String(x.title || "").slice(0, 140), startUtcMs: +x.startUtcMs,
      })).filter((x) => Number.isFinite(x.startUtcMs));
      await sql`INSERT INTO planner_upcoming (user_id, data, updated_at) VALUES (${user.sub}, ${JSON.stringify(clean)}::jsonb, now())
                ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`;
      return json(200, { ok: true, count: clean.length });
    }
    if (event.httpMethod === "DELETE" && body.endpoint) {
      await sql`DELETE FROM planner_push WHERE endpoint = ${body.endpoint} AND user_id = ${user.sub}`;
      return json(200, { ok: true });
    }
    return json(400, { error: "bad request" });
  } catch (err) {
    return json(500, { error: `notify error: ${String(err && err.message ? err.message : err)}` });
  }
};
