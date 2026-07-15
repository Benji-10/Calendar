/* Runs every 5 minutes (netlify.toml). For each user's uploaded occurrence
   list, fires a web push at start time and one hour before, deduped via a
   log table. Dead subscriptions (404/410) are pruned.
   Env: DATABASE_URL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT. */

const { neon } = require("@neondatabase/serverless");
const webpush = require("web-push");

function vapid() {
  const pub = (process.env.VAPID_PUBLIC_KEY || "").trim();
  const priv = (process.env.VAPID_PRIVATE_KEY || "").trim();
  let subj = (process.env.VAPID_SUBJECT || "").trim();
  /* Apple's push service returns 403 BadJwtToken for a malformed subject.
     Accept the common broken formats and canonicalise: strip angle brackets
     and ALL whitespace ("mailto: <a@b.c>" -> "mailto:a@b.c"), then ensure a
     mailto:/https: scheme */
  subj = subj.replace(/[<>]/g, "").replace(/\s+/g, "");
  if (subj && !/^(mailto:|https:)/i.test(subj)) subj = `mailto:${subj}`;
  return { pub, priv, subj, complete: !!(pub && priv && subj) };
}


exports.handler = async () => {
  if (!process.env.DATABASE_URL) return { statusCode: 200, body: "skipped — missing DATABASE_URL" };
  const sql = neon(process.env.DATABASE_URL);
  /* heartbeat FIRST — the diagnostics panel uses it to answer "is the
     scheduled function running at all?", including when VAPID is incomplete */
  try {
    await sql`INSERT INTO planner_notif_log (key) VALUES ('cron_heartbeat')
              ON CONFLICT (key) DO UPDATE SET sent_at = now()`;
  } catch { /* table appears on first notify call — heartbeat resumes then */ }
  const v = vapid();
  if (!v.complete) return { statusCode: 200, body: "skipped — incomplete VAPID env" };
  webpush.setVapidDetails(v.subj, v.pub, v.priv);

  const now = Date.now();
  const WINDOW = 5 * 60e3;  /* the cron cadence */
  const CATCHUP = 10 * 60e3; /* a late or skipped run must not silently drop fires */
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
        /* due = inside the upcoming window, or recently missed (dedup log
           makes catch-up safe); a few minutes late beats never */
        if (f.at >= now + WINDOW || f.at <= now - CATCHUP) continue;
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
