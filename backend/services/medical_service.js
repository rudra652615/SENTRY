// The rules for a citizen's medical information. Nothing here touches the database, so every rule can be tested.

const BLOOD_TYPES = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
const MAX_TEXT = 300;
// Staff can see it only for an SOS sent within this time of now: sharing is for the emergency, not for ever.
const SOS_WINDOW_MS = 72 * 3600 * 1000;

const oneLine = (v) => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

// Reads what the phone sent. Returns { ok: true, value } or { ok: false, message }. Unknown fields are ignored; sharing is on only for a real `true`.
function clean(body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : null;
  if (!b) return { ok: false, message: "Send your medical information as an object." };
  const blood = oneLine(b.bloodType).replace(/[−–—]/g, "-").toUpperCase();
  if (blood && !BLOOD_TYPES.includes(blood)) return { ok: false, message: "That is not a blood type." };
  const value = { bloodType: blood, shareOnSos: b.shareOnSos === true };
  for (const field of ["allergies", "conditions", "medicines", "note"]) {
    const text = oneLine(b[field]);
    if (text.length > MAX_TEXT) return { ok: false, message: `Keep ${field} under ${MAX_TEXT} characters.` };
    value[field] = text;
  }
  return { ok: true, value };
}

const isEmpty = (p) => !p || !["bloodType", "allergies", "conditions", "medicines", "note"].some((k) => oneLine(p[k]));

const pick = (p) => ({ bloodType: p.bloodType || "", allergies: p.allergies || "", conditions: p.conditions || "", medicines: p.medicines || "", note: p.note || "" });

// What staff may see for one SOS: the profile only if the citizen shares it, it has something in it, and the SOS is recent. Otherwise nothing.
function visibleFor(profile, sosMessage, now = Date.now()) {
  if (!profile || profile.shareOnSos !== true || isEmpty(profile) || !sosMessage) return null;
  const sent = new Date(sosMessage.ts || sosMessage.receivedAt).getTime();
  if (!Number.isFinite(sent) || Math.abs(now - sent) > SOS_WINDOW_MS) return null;
  return pick(profile);
}

// For the list: is there something to see? (Says nothing about what it is.)
const isShared = (profile, sosMessage, now) => visibleFor(profile, sosMessage, now) !== null;

module.exports = { BLOOD_TYPES, MAX_TEXT, SOS_WINDOW_MS, clean, isEmpty, pick, visibleFor, isShared };
