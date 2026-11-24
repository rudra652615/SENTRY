// Who receives what a DEVELOPER sends while testing on the real server.
//
// The developer is whoever holds the SENTRY Test Console (and so its secret key). From the console the developer saves the SENTRY account that is
// signed in on the test phone ("my test account"); those accounts are "my devices". While "private mode" is on, what the Test Console sends (the
// demo signal), the new-version announcement, and anything those saved accounts send (a broadcast notice, a geo-targeted alert) is kept to
// those accounts and their phones. No admin or authority account is a developer just because of its role, and nothing comes from a server setting.
//
// It is built so that a test can never hide a real emergency:
//  - It switches itself off after the time the developer chose (30 min, 2 h or 8 h; never more than 24 h).
//  - It only holds back what the console or a saved test account sent. Alerts sent by anyone else, earthquake warnings and the automatic alerts
//    made from real data are never held back.
//  - It will not start unless at least one saved account really exists, so a test can never go to nobody by accident.
//  - If the setting cannot be read, everyone receives.
const MINUTES = [30, 120, 480];
const MAX_MINUTES = 24 * 60;
const MAX_DEVELOPERS = 3;
const KEY = "delivery";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validMinutes(minutes) {
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= MAX_MINUTES && (MINUTES.includes(minutes) || minutes <= 60);
}

// The accounts the developer typed: trimmed, lower case, no repeats, real-looking, at most three. ok is false when something is not an e-mail.
function cleanEmails(list) {
  if (!Array.isArray(list)) return { ok: false, emails: [] };
  const emails = [];
  for (const raw of list) {
    const e = String(raw || "").trim().toLowerCase();
    if (!e) continue;
    if (!EMAIL.test(e) || e.length > 120) return { ok: false, emails: [] };
    if (!emails.includes(e)) emails.push(e);
  }
  return { ok: emails.length <= MAX_DEVELOPERS, emails: emails.slice(0, MAX_DEVELOPERS) };
}

// The filter a list of notifications or alerts uses: a developer account sees everything, everyone else never sees what was kept private.
function visibleFilter(isDeveloper) {
  return isDeveloper ? {} : { developerOnly: { $ne: true } };
}

function createDeliveryMode({ settings, users, now = () => Date.now(), cacheMs = 5000, idsCacheMs = 60000 } = {}) {
  const store = () => settings || require("../models/app_setting");
  const people = () => users || require("../models/user");
  let valueCache = { at: -Infinity, value: { privateUntil: 0, developers: [] } };
  let idsCache = { at: -Infinity, ids: [] };
  let wasPrivate = null;

  async function read() {
    if (now() - valueCache.at < cacheMs) return valueCache.value;
    let value = { privateUntil: 0, developers: [] };
    try {
      const row = await store().findOne({ key: KEY }).lean();
      const v = (row && row.value) || {};
      value = { privateUntil: Number(v.privateUntil) || 0, developers: Array.isArray(v.developers) ? v.developers.map(String) : [] };
    } catch { /* if the setting cannot be read, everyone receives: a failure must never hold an alert back */ }
    valueCache = { at: now(), value };
    return value;
  }

  async function privateNow() { return (await read()).privateUntil > now(); }

  async function developerIds({ fresh = false } = {}) {
    if (!fresh && now() - idsCache.at < idsCacheMs) return idsCache.ids;
    const emails = (await read()).developers;
    let ids = [];
    if (emails.length) {
      try { ids = (await people().find({ email: { $in: emails } }, { _id: 1 }).lean()).map((r) => String(r._id)); } catch { ids = idsCache.ids; }
    }
    idsCache = { at: now(), ids };
    return ids;
  }

  // For code that cannot wait (the live stream decides per phone): the answer from the last time the list was read.
  function isDeveloperIdSync(userId) { return Boolean(userId) && idsCache.ids.includes(String(userId)); }

  async function isDeveloper(userId) { return Boolean(userId) && (await developerIds()).includes(String(userId)); }

  // True only for a saved test account's own action while private mode is on.
  async function shouldKeepPrivate(userId) { return (await privateNow()) && (await isDeveloper(userId)); }

  async function status({ withAccounts = false } = {}) {
    const value = await read();
    const active = value.privateUntil > now();
    const out = { everyone: !active, until: active ? new Date(value.privateUntil).toISOString() : null, remainingMs: active ? value.privateUntil - now() : 0, choices: MINUTES };
    if (withAccounts) out.accounts = value.developers;
    return out;
  }

  async function write(patch) {
    const current = await read();
    const next = { privateUntil: current.privateUntil, developers: current.developers, ...patch };
    await store().findOneAndUpdate({ key: KEY }, { $set: { value: next } }, { upsert: true });
    valueCache = { at: now(), value: next };
    idsCache = { at: -Infinity, ids: [] };
    wasPrivate = next.privateUntil > now();
  }

  const setEveryone = () => write({ privateUntil: 0 });

  async function setDevelopers(list) {
    const checked = cleanEmails(list);
    if (!checked.ok) throw new RangeError("accounts must be up to three e-mail addresses");
    await write({ developers: checked.emails });
  }

  // Never starts unless at least one saved account really exists on this server.
  async function setPrivate(minutes) {
    if (!validMinutes(minutes)) throw new RangeError("minutes must be 30, 120 or 480");
    const ids = await developerIds({ fresh: true });
    if (!ids.length) { const e = new Error("no saved test account exists"); e.code = "NO_DEVELOPER"; throw e; }
    await write({ privateUntil: now() + minutes * 60000 });
  }

  // Call every minute: when a private period has run out, tell the caller once (it then announces what was kept back).
  async function watch(onEnd) {
    const active = await privateNow();
    const was = wasPrivate;
    wasPrivate = active;
    if (was && !active) { try { await onEnd(); } catch { /* the next minute does not repeat it */ } return true; }
    return false;
  }

  return { privateNow, developerIds, isDeveloperIdSync, isDeveloper, shouldKeepPrivate, status, setEveryone, setPrivate, setDevelopers, watch, _reset: () => { valueCache = { at: -Infinity, value: { privateUntil: 0, developers: [] } }; idsCache = { at: -Infinity, ids: [] }; wasPrivate = null; } };
}

const instance = createDeliveryMode();

module.exports = { createDeliveryMode, cleanEmails, validMinutes, visibleFilter, MINUTES, MAX_MINUTES, MAX_DEVELOPERS, default: instance };
