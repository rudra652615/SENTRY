const MeshMessage = require("../models/mesh_message");
const User = require("../models/user");
const MedicalProfile = require("../models/medical_profile");
const MedicalAccess = require("../models/medical_access");
const sos = require("../services/sos_service");
const medical = require("../services/medical_service");

const SOS_QUERY = { kind: "report", "body.incidentType": "sos" };

async function peopleFor(messages) {
  const ids = [...new Set(messages.map((m) => String(m.userId)))];
  const [users, profiles] = await Promise.all([
    User.find({ _id: { $in: ids } }).select("name phone").lean(),
    MedicalProfile.find({ userId: { $in: ids } }).lean(),
  ]);
  return { users: new Map(users.map((u) => [String(u._id), u])), profiles: new Map(profiles.map((p) => [String(p.userId), p])) };
}

// GET /api/sos?state=open|handled : the SOS calls staff can see, newest first. The list only says whether medical information is shared, never what it is.
const list = async (req, res) => {
  try {
    const query = { ...SOS_QUERY };
    if (req.query.state === "open") query.handledAt = null;
    else if (req.query.state === "handled") query.handledAt = { $ne: null };
    const messages = await MeshMessage.find(query).sort({ receivedAt: -1 }).limit(100).lean();
    const { users, profiles } = await peopleFor(messages);
    const items = messages.map((m) => sos.item(m, users.get(String(m.userId)), profiles.get(String(m.userId))));
    return res.json({ success: true, sos: items });
  } catch {
    return res.status(500).json({ success: false, message: "Could not load the SOS calls." });
  }
};

// GET /api/sos/:id : one SOS. The medical information comes back only when the citizen shares it and the SOS is recent; opening it is recorded.
const detail = async (req, res) => {
  try {
    const message = await MeshMessage.findOne({ ...SOS_QUERY, envId: String(req.params.id) }).lean();
    if (!message) return res.status(404).json({ success: false, message: "That SOS was not found." });
    const { users, profiles } = await peopleFor([message]);
    const profile = profiles.get(String(message.userId));
    const shown = medical.visibleFor(profile, message);
    if (shown) await MedicalAccess.create({ profileUserId: message.userId, viewerId: req.user.userId, envId: message.envId });
    const state = shown ? "shared" : profile && !medical.isEmpty(profile) ? "not-shared" : "none";
    return res.json({ success: true, sos: sos.item(message, users.get(String(message.userId)), profile), medical: shown, medicalState: state });
  } catch {
    return res.status(500).json({ success: false, message: "Could not load that SOS." });
  }
};

// PATCH /api/sos/:id/handled : staff mark the SOS dealt with (or open again with { handled: false }).
const setHandled = async (req, res) => {
  try {
    const handled = req.body?.handled !== false;
    const row = await MeshMessage.findOneAndUpdate({ ...SOS_QUERY, envId: String(req.params.id) }, { $set: handled ? { handledAt: new Date(), handledBy: req.user.userId } : { handledAt: null, handledBy: null } }, { new: true }).lean();
    if (!row) return res.status(404).json({ success: false, message: "That SOS was not found." });
    return res.json({ success: true, handled });
  } catch {
    return res.status(500).json({ success: false, message: "Could not update that SOS." });
  }
};

module.exports = { list, detail, setHandled };
