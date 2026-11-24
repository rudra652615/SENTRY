// Phone push through Firebase Cloud Messaging. When a notification is saved the server sends every registered phone a short silent message,
// "ask the server for your notifications". The phone then asks, exactly as it does for the live stream, so the push carries nothing private.
//
// It does nothing until the server has a Firebase service account in its environment (FIREBASE_SERVICE_ACCOUNT: the JSON text, or the same
// text in base64). Without it the app keeps its own connection open instead (/api/live), so alerts still arrive.
const PushToken = require("../models/push_token");

let messaging = null;
let tried = false;

function loadMessaging() {
  if (messaging || tried) return messaging;
  tried = true;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const text = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
    const { initializeApp, getApps, getApp, cert } = require("firebase-admin/app");
    const { getMessaging } = require("firebase-admin/messaging");
    const app = getApps().length ? getApp() : initializeApp({ credential: cert(JSON.parse(text)) });
    messaging = getMessaging(app);
  } catch (error) {
    console.warn("[push] Firebase is not set up correctly:", error.message);
    messaging = null;
  }
  return messaging;
}

const enabled = () => Boolean(loadMessaging());

// One push covers every notification saved in the same two seconds. If any of them is for everyone, the push goes to everyone; only when every
// one of them was kept private by a developer (options.audience === "developer") does it go to the developer's phones alone.
let timer = null;
let pendingPublic = false;
function ping(options = {}) {
  const send = options.messaging || loadMessaging();
  if (!send) return;
  if (options.audience !== "developer") pendingPublic = true;
  if (timer) return;
  timer = setTimeout(async () => {
    timer = null;
    const audience = pendingPublic ? undefined : "developer";
    pendingPublic = false;
    try { await sendToAll(send, { ...options, audience }); } catch (error) { console.warn("[push] send failed:", error.message); }
  }, options.delayMs ?? 2000);
  if (timer.unref) timer.unref();
}

// What the last send did, for the administrator's health screen.
let lastResult = null;
const status = () => ({ configured: enabled(), last: lastResult });

async function sendToAll(m, { model = PushToken, data = { type: "notification" }, audience, developerIds, citizensOnly = false, ttlMs = 6 * 3600 * 1000 } = {}) {
  let rows;
  if (audience === "developer") {
    const ids = await (developerIds || (() => require("./delivery_mode").default.developerIds()))();
    rows = ids.length ? await model.find({ userId: { $in: ids } }, { token: 1 }).lean() : [];
  } else {
    rows = await model.find({}, { token: 1 }).lean();
  }
  const found = rows.length; // counts for the Test Console's report, nothing private
  if (citizensOnly && rows.length) {
    // The Test Console's scenes are for citizen phones only (authority and admin phones never play one).
    const citizens = new Set((await require("../models/user").find({ _id: { $in: rows.map((r) => r.userId) }, role: "citizen" }, { _id: 1 }).lean()).map((u) => String(u._id)));
    rows = rows.filter((r) => citizens.has(String(r.userId)));
  }
  let sent = 0;
  let failed = 0;
  const lastErrors = [];
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const result = await m.sendEachForMulticast({
      tokens: chunk.map((r) => r.token),
      data,
      android: { priority: "high", ttl: ttlMs },
    });
    const dead = [];
    sent += result.responses.filter((r) => r.success).length;
    failed += result.responses.filter((r) => !r.success).length;
    result.responses.forEach((r, k) => {
      const code = r.error && r.error.code;
      if (code) lastErrors.push(String(code)); // only Firebase's error code, nothing private
      if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") dead.push(chunk[k].token);
    });
    if (dead.length) await model.deleteMany({ token: { $in: dead } });
  }
  lastResult = { at: new Date().toISOString(), phones: rows.length, sent, failed, audience: audience === "developer" ? "developer" : "everyone", type: data && data.type };
  const errors = [...new Set(lastErrors)].slice(0, 3);
  return { sent, failed, phones: rows.length, found, errors };
}

// A Test Console scene as a data-only push (the scene's name and a version, nothing private). It lives 60 seconds only, so a test plays at the
// moment of the press and never later. Phones that keep the app's own live line open hear the same scene there; a version plays once per phone.
// A phone that gave up that line because push works (the normal case) hears it here. Citizen phones only; in private test mode only the developer's.
async function sendDemo(scene, version, { developersOnly = false, messaging = loadMessaging(), model, developerIds } = {}) {
  if (!messaging) return { sent: 0, failed: 0, reason: "push is not set up" };
  return sendToAll(messaging, { model, developerIds, data: { type: "demo", scene: String(scene), version: String(version) }, audience: developersOnly ? "developer" : undefined, citizensOnly: true, ttlMs: 60 * 1000 });
}

// A new app version was configured (APP_LATEST_*): every phone gets one silent "update" message, once per version. The phone then asks the server
// what is new and shows its own "A new SENTRY is ready" notification. Citizens and authorities alike; nothing private is sent.
async function announceUpdate({ messaging = loadMessaging(), model = PushToken, record = require("../models/app_announcement"), offer = require("./app_update_service").latest(), privateNow = () => require("./delivery_mode").default.privateNow() } = {}) {
  if (!messaging || !offer) return { sent: false, reason: !messaging ? "push is not set up" : "no update configured" };
  const done = await record.findOne({ key: "update" }).lean();
  if (done && done.versionCode >= offer.versionCode) return { sent: false, reason: "already announced" };
  // A developer's private test mode keeps the announcement to the developer's phones, and does NOT record it: it goes to everyone when the mode ends.
  if (await privateNow()) {
    await sendToAll(messaging, { model, data: { type: "update", versionCode: String(offer.versionCode) }, audience: "developer" });
    return { sent: true, audience: "developer", versionCode: offer.versionCode };
  }
  // Recorded before sending: if anything fails halfway, phones are never told twice (they also find the update when they open the app).
  await record.findOneAndUpdate({ key: "update" }, { $set: { versionCode: offer.versionCode, announcedAt: new Date() } }, { upsert: true });
  await sendToAll(messaging, { model, data: { type: "update", versionCode: String(offer.versionCode) } });
  return { sent: true, versionCode: offer.versionCode };
}

// One data-only push to every registered phone (strings only; carries nothing private). False when push is not set up.
async function broadcast(data, options = {}) {
  const send = options.messaging || loadMessaging();
  if (!send) return false;
  try { await sendToAll(send, { model: options.model, data }); return true; } catch (error) { console.warn("[push] broadcast failed:", error.message); return false; }
}

function attach(notificationModel) {
  notificationModel.schema.post("save", (doc) => { try { ping(doc && doc.developerOnly ? { audience: "developer" } : {}); } catch { /* a failed push must never fail a save */ } });
}

module.exports = { enabled, status, ping, sendToAll, sendDemo, announceUpdate, broadcast, attach, _reset: () => { messaging = null; tried = false; lastResult = null; pendingPublic = false; if (timer) { clearTimeout(timer); timer = null; } } };
