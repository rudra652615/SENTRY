// Earthquakes for India and the area around it, from the public USGS feed. The server publishes them; each phone decides by its own distance whether
// to warn its owner (the server does not know where phones are). A big new one also sends every phone one quiet push so they can warn at once.
const REGION = { minLat: 5, maxLat: 38, minLng: 66, maxLng: 99 };
const FEED_MIN_MAG = 3.5;
const ALERT_MIN_MAG = 5.0;
const ALERT_MAX_AGE_MS = 3 * 3600 * 1000;

function feedUrl(now = Date.now(), days = 2) {
  const start = new Date(now - days * 86400000).toISOString().slice(0, 19);
  return "https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&orderby=time&limit=200"
    + `&minmagnitude=${FEED_MIN_MAG}&starttime=${start}`
    + `&minlatitude=${REGION.minLat}&maxlatitude=${REGION.maxLat}&minlongitude=${REGION.minLng}&maxlongitude=${REGION.maxLng}`;
}

// USGS GeoJSON -> our records. Anything malformed is skipped.
function parseUsgs(json) {
  const out = [];
  for (const f of Array.isArray(json?.features) ? json.features : []) {
    const p = f?.properties || {}, c = f?.geometry?.coordinates || [];
    const mag = Number(p.mag), time = Number(p.time), lng = Number(c[0]), lat = Number(c[1]);
    if (!f.id || !Number.isFinite(mag) || !Number.isFinite(time) || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    out.push({ eventId: String(f.id), mag: Math.round(mag * 10) / 10, place: String(p.place || "").slice(0, 120), lat, lng, depthKm: Number.isFinite(Number(c[2])) ? Number(c[2]) : null, time: new Date(time), source: "usgs" });
  }
  return out;
}

const alertWorthy = (q, now = Date.now()) => q.mag >= ALERT_MIN_MAG && now - new Date(q.time).getTime() <= ALERT_MAX_AGE_MS;

// What a push carries: strings only, nothing private (it goes to every phone).
const pushData = (q) => ({ type: "quake", id: q.eventId, mag: String(q.mag), lat: String(q.lat), lng: String(q.lng), place: q.place, time: String(new Date(q.time).getTime()) });

// One look at the feed. `deps` lets tests replace the network, the database and the push.
async function refresh(deps = {}) {
  const now = deps.now ?? Date.now();
  const fetchJson = deps.fetchJson || (async (url) => { const r = await fetch(url, { signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error(`USGS answered ${r.status}`); return r.json(); });
  const model = deps.model || require("../models/earthquake");
  const push = deps.push || require("./push_service");
  const quakes = parseUsgs(await fetchJson(feedUrl(now)));
  let added = 0, alerted = 0;
  for (const q of quakes) {
    const result = await model.updateOne({ eventId: q.eventId }, { $setOnInsert: { ...q, alerted: false } }, { upsert: true });
    const isNew = (result?.upsertedCount ?? (result?.upsertedId ? 1 : 0)) > 0;
    if (!isNew) continue;
    added += 1;
    if (alertWorthy(q, now)) {
      // marked first, so a failed push can never be repeated for the same quake
      await model.updateOne({ eventId: q.eventId }, { $set: { alerted: true } });
      if (await push.broadcast(pushData(q))) alerted += 1;
    }
  }
  return { seen: quakes.length, added, alerted };
}

// The list the app reads: newest first.
const view = (q) => ({ id: q.eventId, mag: q.mag, place: q.place, lat: q.lat, lng: q.lng, depthKm: q.depthKm ?? null, time: q.time });

module.exports = { REGION, FEED_MIN_MAG, ALERT_MIN_MAG, feedUrl, parseUsgs, alertWorthy, pushData, refresh, view };
