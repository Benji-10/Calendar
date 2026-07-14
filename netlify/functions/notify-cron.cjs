/* Runs every 5 minutes (netlify.toml). For each user's uploaded occurrence
   list, fires a web push at start time and one hour before, deduped via a
   log table. Dead subscriptions (404/410) are pruned.
   Env: DATABASE_URL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT. */

const { neon } = require("@neondatabase/serverless");
const webpush = require("web-push");

exports.handler = async () => {
  const need = ["DATABASE_URL", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"];
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length) return { statusCode: 200, body: `skipped — missing ${missing.join(", ")}` };
  webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  const sql = neon(process.env.DATABASE_URL);

  const now = Date.now();
  const WINDOW = 5 * 60e3; /* matches the cron cadence */
  const rows = await sql`
    SELECT u.user_id, u.data, p.endpoint, p.sub
    FROM planner_upcoming u JOIN planner_push p ON p.user_id = u.user_id
    WHERE u.updated_at > now() - interval '3 days'`;

  let sent = 0;
  for (const row of rows) {
    for (const item of row.data || []) {
      const fires = [
        { kind: "now", at: item.startUtcMs, body: "starting now" },
        { kind: "lead", at: item.startUtcMs - 3600e3, body: "in 1 hour" },
      ];
      for (const f of fires) {
        if (f.at < now || f.at >= now + WINDOW) continue;
        const key = `${row.user_id}_${item.key}_${f.kind}`;
        const logged = await sql`INSERT INTO planner_notif_log (key) VALUES (${key}) ON CONFLICT (key) DO NOTHING RETURNING key`;
        if (!logged[0]) continue; /* another run already sent it */
        try {
          await webpush.sendNotification(row.sub, JSON.stringify({ title: item.title, body: f.body, tag: key }));
          sent++;
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) {
            await sql`DELETE FROM planner_push WHERE endpoint = ${row.endpoint}`;
          }
        }
      }
    }
  }
  await sql`DELETE FROM planner_notif_log WHERE sent_at < now() - interval '14 days'`;
  return { statusCode: 200, body: `sent ${sent}` };
};
