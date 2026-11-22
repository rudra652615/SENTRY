// What staff see of an SOS. An SOS reaches the server as a signed message from a citizen's phone (directly, or handed over by a nearby phone).
// These rules turn that message into a list item. Nothing here touches the database.
const medical = require("./medical_service");

const NEEDS = ["Medical help", "Trapped", "Food and water", "Shelter", "Other"];

const isSos = (m) => Boolean(m && m.kind === "report" && m.body && String(m.body.incidentType || "").toLowerCase() === "sos");

// "SOS: asks for help. Needs: Medical help, Trapped" -> ["Medical help", "Trapped"]. Only the known words are kept.
function parseNeeds(description) {
  const m = /needs?:\s*(.+)$/i.exec(String(description || ""));
  if (!m) return [];
  return m[1].split(",").map((s) => s.trim()).filter((s) => NEEDS.includes(s));
}

// Words only a phone can build: the needs go into the signed description. Kept here so the server and the app agree.
function describe(needs) {
  const list = (Array.isArray(needs) ? needs : []).filter((n) => NEEDS.includes(n));
  return list.length ? `SOS: asks for help. Needs: ${list.join(", ")}` : "SOS: asks for help";
}

// One list item. `user` is { name, phone } of the sender (may be missing), `profile` the sender's medical record (may be missing).
function item(message, user, profile, now = Date.now()) {
  const carried = Boolean(message.carrierUserId) && String(message.carrierUserId) !== String(message.userId);
  return {
    id: message.envId,
    at: message.ts,
    receivedAt: message.receivedAt,
    lat: message.body.lat,
    lng: message.body.lng,
    needs: parseNeeds(message.body.description),
    viaNearbyPhone: carried,
    handled: Boolean(message.handledAt),
    handledAt: message.handledAt || null,
    name: user?.name || "",
    phone: user?.phone || "",
    medicalShared: medical.isShared(profile, message, now),
  };
}

module.exports = { NEEDS, isSos, parseNeeds, describe, item };
