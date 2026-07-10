/* Email-to-event pipeline.
   - POST ?secret=...   inbound-email webhook (CloudMailin/Postmark-style JSON).
                        Routes by the +token in the To address, parses the
                        email, stores pending suggestions. No JWT (webhook),
                        guarded by INBOUND_SECRET.
   - GET  (JWT)         { address, suggestions } — lazily creates the user's
                        forwarding token. { unconfigured: true } until
                        INBOUND_ADDRESS/INBOUND_SECRET env vars exist.
   - PUT  (JWT)         { id, action: "accepted" | "dismissed" }.
   Env: DATABASE_URL, INBOUND_ADDRESS (e.g. abc123@cloudmailin.net), INBOUND_SECRET. */

const { neon } = require("@neondatabase/serverless");
const { parseEmail } = require("./lib/parse-email.cjs");

let ensured = null;
async function ensureTables(sql) {
  if (!ensured) {
    ensured = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS planner_email_tokens (
          token text PRIMARY KEY,
          user_id text NOT NULL UNIQUE,
          created_at timestamptz NOT NULL DEFAULT now()
        )`;
      await sql`
        CREATE TABLE IF NOT EXISTS planner_suggestions (
          id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          user_id text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          from_addr text,
          subject text,
          payload jsonb NOT NULL,
          status text NOT NULL DEFAULT 'pending'
        )`;
      await sql`CREATE INDEX IF NOT EXISTS planner_suggestions_user ON planner_suggestions (user_id, status, id DESC)`;
    })();
  }
  await ensured;
}

const json = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
const newToken = () => Array.from({ length: 20 }, () => "abcdefghjkmnpqrstuvwxyz23456789"[Math.floor(Math.random() * 31)]).join("");

/* pull normalized fields out of common inbound-provider payloads */
function normalizeInbound(body) {
  const to =
    (body.envelope && body.envelope.to) ||
    (Array.isArray(body.ToFull) && body.ToFull[0] && body.ToFull[0].Email) ||
    body.To || body.to || "";
  const subject = (body.headers && body.headers.subject) || body.Subject || body.subject || "";
  const from = (body.headers && body.headers.from) || body.From || body.from || "";
  const text = body.plain || body.TextBody || body.text || "";
  const html = body.html || body.HtmlBody || "";
  return { to: String(to), subject: String(subject), from: String(from), text: String(text), html: String(html) };
}

exports.handler = async (event, context) => {
  try {
  if (!process.env.DATABASE_URL) return json(500, { error: "DATABASE_URL not configured" });
  const sql = neon(process.env.DATABASE_URL);
  await ensureTables(sql);

  /* ---------- inbound webhook ---------- */
  if (event.httpMethod === "POST") {
    const secret = event.queryStringParameters && event.queryStringParameters.secret;
    if (!process.env.INBOUND_SECRET || secret !== process.env.INBOUND_SECRET) return json(401, { error: "bad secret" });
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "bad json" }); }
    const mail = normalizeInbound(body);
    const tokenMatch = mail.to.match(/\+([a-z0-9]+)@/i);
    if (!tokenMatch) return json(200, { ok: true, note: "no token in address" });
    const rows = await sql`SELECT user_id FROM planner_email_tokens WHERE token = ${tokenMatch[1].toLowerCase()}`;
    if (!rows[0]) return json(200, { ok: true, note: "unknown token" });
    const userId = rows[0].user_id;

    const suggestions = parseEmail(mail);
    let stored = 0;
    for (const s of suggestions) {
      const dupe = await sql`
        SELECT 1 FROM planner_suggestions
        WHERE user_id = ${userId} AND status = 'pending' AND payload = ${JSON.stringify(s)}::jsonb`;
      if (dupe[0]) continue;
      await sql`
        INSERT INTO planner_suggestions (user_id, from_addr, subject, payload)
        VALUES (${userId}, ${mail.from.slice(0, 200)}, ${mail.subject.slice(0, 300)}, ${JSON.stringify(s)}::jsonb)`;
      stored++;
    }
    return json(200, { ok: true, parsed: suggestions.length, stored });
  }

  /* ---------- authenticated app calls ---------- */
  const user = context.clientContext && context.clientContext.user;
  if (!user) return json(401, { error: "Not signed in" });

  if (event.httpMethod === "GET") {
    const missing = [
      !process.env.INBOUND_ADDRESS && "INBOUND_ADDRESS",
      !process.env.INBOUND_SECRET && "INBOUND_SECRET",
    ].filter(Boolean);
    if (missing.length) return json(200, { unconfigured: true, missing, context: process.env.CONTEXT || "unknown", suggestions: [] });
    let tok = await sql`SELECT token FROM planner_email_tokens WHERE user_id = ${user.sub}`;
    if (!tok[0]) {
      const t = newToken();
      await sql`INSERT INTO planner_email_tokens (token, user_id) VALUES (${t}, ${user.sub}) ON CONFLICT (user_id) DO NOTHING`;
      tok = await sql`SELECT token FROM planner_email_tokens WHERE user_id = ${user.sub}`;
    }
    const [local, domain] = process.env.INBOUND_ADDRESS.split("@");
    const address = `${local}+${tok[0].token}@${domain}`;
    const rows = await sql`
      SELECT id, created_at, from_addr, subject, payload FROM planner_suggestions
      WHERE user_id = ${user.sub} AND status = 'pending' ORDER BY id DESC LIMIT 25`;
    return json(200, { address, suggestions: rows });
  }

  if (event.httpMethod === "PUT") {
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "bad json" }); }
    if (!body.id || !["accepted", "dismissed"].includes(body.action)) return json(400, { error: "bad action" });
    await sql`UPDATE planner_suggestions SET status = ${body.action} WHERE user_id = ${user.sub} AND id = ${body.id}`;
    return json(200, { ok: true });
  }

  return json(405, { error: "Method not allowed" });
  } catch (err) {
    return json(500, { error: `email function error: ${String(err && err.message ? err.message : err)}` });
  }
};
