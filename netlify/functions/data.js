/* Per-user data blob in Neon Postgres.
   Auth: Netlify Identity JWT -> context.clientContext.user (verified by Netlify).
   Env: DATABASE_URL = Neon connection string. */

const { neon } = require("@neondatabase/serverless");

let ensured = null;
async function ensureTable(sql) {
  if (!ensured) {
    ensured = sql`
      CREATE TABLE IF NOT EXISTS planner_data (
        user_id text PRIMARY KEY,
        data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`;
  }
  await ensured;
}

exports.handler = async (event, context) => {
  const user = context.clientContext && context.clientContext.user;
  if (!user) return { statusCode: 401, body: JSON.stringify({ error: "Not signed in" }) };
  if (!process.env.DATABASE_URL) return { statusCode: 500, body: JSON.stringify({ error: "DATABASE_URL not configured" }) };

  const sql = neon(process.env.DATABASE_URL);
  await ensureTable(sql);

  if (event.httpMethod === "GET") {
    const rows = await sql`SELECT data FROM planner_data WHERE user_id = ${user.sub}`;
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: rows[0] ? rows[0].data : null }) };
  }

  if (event.httpMethod === "PUT") {
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, body: JSON.stringify({ error: "Bad JSON" }) }; }
    if (!body.data) return { statusCode: 400, body: JSON.stringify({ error: "Missing data" }) };
    await sql`
      INSERT INTO planner_data (user_id, data, updated_at)
      VALUES (${user.sub}, ${JSON.stringify(body.data)}::jsonb, now())
      ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`;
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
};
