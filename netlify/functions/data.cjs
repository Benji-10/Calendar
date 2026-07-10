/* Per-user data blob in Neon Postgres, with automatic write history.
   Auth: Netlify Identity JWT -> context.clientContext.user (verified by Netlify).
   Env: DATABASE_URL = Neon connection string.

   DATA-SAFETY CONTRACT (do not weaken):
   - Every PUT that changes the blob first snapshots the previous version
     into planner_history (last 20 kept per user). Nothing is ever one
     overwrite away from gone, whatever bug or migration goes wrong.
   - Schema changes are additive: the client's migrate() fills defaults on
     read. Any future breaking change must be query -> transform -> reinsert,
     never a destructive rewrite.

   Endpoints:
   - GET                  -> { data }
   - GET ?history=1       -> { history: [{ id, saved_at, tasks, events }] }
   - PUT { data }         -> snapshot old, save new
   - PUT { restore: id }  -> snapshot current, restore that history version */

const { neon } = require("@neondatabase/serverless");

let ensured = null;
async function ensureTables(sql) {
  if (!ensured) {
    ensured = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS planner_data (
          user_id text PRIMARY KEY,
          data jsonb NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        )`;
      await sql`
        CREATE TABLE IF NOT EXISTS planner_history (
          id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          user_id text NOT NULL,
          data jsonb NOT NULL,
          saved_at timestamptz NOT NULL DEFAULT now()
        )`;
      await sql`CREATE INDEX IF NOT EXISTS planner_history_user ON planner_history (user_id, id DESC)`;
    })();
  }
  await ensured;
}

async function snapshot(sql, userId) {
  /* copy the current row into history, then prune to the newest 20 */
  const cur = await sql`SELECT data FROM planner_data WHERE user_id = ${userId}`;
  if (!cur[0]) return;
  await sql`INSERT INTO planner_history (user_id, data) VALUES (${userId}, ${JSON.stringify(cur[0].data)}::jsonb)`;
  await sql`
    DELETE FROM planner_history
    WHERE user_id = ${userId}
      AND id NOT IN (SELECT id FROM planner_history WHERE user_id = ${userId} ORDER BY id DESC LIMIT 20)`;
}

exports.handler = async (event, context) => {
  const user = context.clientContext && context.clientContext.user;
  if (!user) return { statusCode: 401, body: JSON.stringify({ error: "Not signed in" }) };
  if (!process.env.DATABASE_URL) return { statusCode: 500, body: JSON.stringify({ error: "DATABASE_URL not configured" }) };

  const sql = neon(process.env.DATABASE_URL);
  await ensureTables(sql);
  const json = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

  if (event.httpMethod === "GET") {
    if (event.queryStringParameters && event.queryStringParameters.history) {
      const rows = await sql`
        SELECT id, saved_at,
               COALESCE(jsonb_array_length(data->'tasks'), 0) AS tasks,
               COALESCE(jsonb_array_length(data->'events'), 0) AS events
        FROM planner_history WHERE user_id = ${user.sub} ORDER BY id DESC`;
      return json(200, { history: rows });
    }
    const rows = await sql`SELECT data FROM planner_data WHERE user_id = ${user.sub}`;
    return json(200, { data: rows[0] ? rows[0].data : null });
  }

  if (event.httpMethod === "PUT") {
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "Bad JSON" }); }

    if (body.restore) {
      const rows = await sql`SELECT data FROM planner_history WHERE user_id = ${user.sub} AND id = ${body.restore}`;
      if (!rows[0]) return json(404, { error: "No such history version" });
      await snapshot(sql, user.sub);
      await sql`
        INSERT INTO planner_data (user_id, data, updated_at)
        VALUES (${user.sub}, ${JSON.stringify(rows[0].data)}::jsonb, now())
        ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`;
      return json(200, { ok: true, restored: body.restore });
    }

    if (!body.data) return json(400, { error: "Missing data" });
    /* snapshot only when the write actually changes something */
    const cur = await sql`SELECT data FROM planner_data WHERE user_id = ${user.sub}`;
    if (cur[0] && JSON.stringify(cur[0].data) !== JSON.stringify(body.data)) {
      await snapshot(sql, user.sub);
    }
    await sql`
      INSERT INTO planner_data (user_id, data, updated_at)
      VALUES (${user.sub}, ${JSON.stringify(body.data)}::jsonb, now())
      ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`;
    return json(200, { ok: true });
  }

  return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
};
