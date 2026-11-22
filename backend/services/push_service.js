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

// One push covers every notification saved in the same two seconds.
let timer = null;
function ping(options = {}) {
  const send = options.messaging || loadMessaging();
  if (!send) return;
  if (timer) return;
  timer = setTimeout(async () => {
    timer = null;
    try { await sendToAll(send, options); } catch (error) { console.warn("[push] send failed:", error.message); }
  }, options.delayMs ?? 2000);
  if (timer.unref) timer.unref();
}

async function sendToAll(m, { model = PushToken, data = { type: "notification" } } = {}) {
  const rows = await model.find({}, { token: 1 }).lean();
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const result = await m.sendEachForMulticast({
      tokens: chunk.map((r) => r.token),
      data,
      android: { priority: "high", ttl: 6 * 3600 * 1000 },
    });
    const dead = [];
    result.responses.forEach((r, k) => {
      const code = r.error && r.error.code;
      if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") dead.push(chunk[k].token);
    });
    if (dead.length) await model.deleteMany({ token: { $in: dead } });
  }
}

// A new app version was configured (APP_LATEST_*): every phone gets one silent "update" message, once per version. The phone then asks the server
// what is new and shows its own "A new SENTRY is ready" notification. Citizens and authorities alike; nothing private is sent.
async function announceUpdate({ messaging = loadMessaging(), model = PushToken, record = require("../models/app_announcement"), offer = require("./app_update_service").latest() } = {}) {
  if (!messaging || !offer) return { sent: false, reason: !messaging ? "push is not set up" : "no update configured" };
  const done = await record.findOne({ key: "update" }).lean();
  if (done && done.versionCode >= offer.versionCode) return { sent: false, reason: "already announced" };
  // Recorded before sending: if anything fails halfway, phones are never told twice (they also find the update when they open the app).
  await record.findOneAndUpdate({ key: "update" }, { $set: { versionCode: offer.versionCode, announcedAt: new Date() } }, { upsert: true });
  await sendToAll(messaging, { model, data: { type: "update", versionCode: String(offer.versionCode) } });
  return { sent: true, versionCode: offer.versionCode };
}

function attach(notificationModel) {
  notificationModel.schema.post("save", () => { try { ping(); } catch { /* a failed push must never fail a save */ } });
}

module.exports = { enabled, ping, sendToAll, announceUpdate, attach, _reset: () => { messaging = null; tried = false; if (timer) { clearTimeout(timer); timer = null; } } };
