/* Server-side ICS fetcher: browsers can't fetch most calendar feeds directly
   because of CORS, so this proxies them. Guarded against being used as a
   general request proxy into private networks. */
exports.handler = async (event) => {
  const url = event.queryStringParameters && event.queryStringParameters.url;
  if (!url) return { statusCode: 400, body: "missing url" };
  let u;
  try {
    u = new URL(url.replace(/^webcal:/i, "https:"));
  } catch {
    return { statusCode: 400, body: "bad url" };
  }
  if (!/^https?:$/.test(u.protocol)) return { statusCode: 400, body: "bad protocol" };
  if (/^(localhost|127\.|10\.|0\.|192\.168\.|169\.254\.|\[?::1)/i.test(u.hostname)) {
    return { statusCode: 400, body: "blocked host" };
  }
  try {
    const r = await fetch(u.toString(), { headers: { "user-agent": "rollover-calendar" }, redirect: "follow" });
    if (!r.ok) return { statusCode: 502, body: `upstream ${r.status}` };
    const text = await r.text();
    if (text.length > 3_000_000) return { statusCode: 413, body: "feed too large" };
    return {
      statusCode: 200,
      headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "public, max-age=3600" },
      body: text,
    };
  } catch {
    return { statusCode: 502, body: "fetch failed" };
  }
};
