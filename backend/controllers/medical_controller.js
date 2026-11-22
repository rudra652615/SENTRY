const MedicalProfile = require("../models/medical_profile");
const medical = require("../services/medical_service");

// The signed-in citizen's own medical information. Only ever their own: the account comes from the sign-in, never from the request.
const getMine = async (req, res) => {
  try {
    const row = await MedicalProfile.findOne({ userId: req.user.userId }).lean();
    return res.json({ success: true, profile: row ? { ...medical.pick(row), shareOnSos: row.shareOnSos === true, updatedAt: row.updatedAt } : null });
  } catch {
    return res.status(500).json({ success: false, message: "Could not load your medical information." });
  }
};

const saveMine = async (req, res) => {
  const checked = medical.clean(req.body);
  if (!checked.ok) return res.status(400).json({ success: false, message: checked.message });
  try {
    const before = await MedicalProfile.findOne({ userId: req.user.userId }).select("shareOnSos consentAt").lean();
    const consentAt = checked.value.shareOnSos ? (before?.shareOnSos && before.consentAt ? before.consentAt : new Date()) : null;
    const row = await MedicalProfile.findOneAndUpdate({ userId: req.user.userId }, { $set: { ...checked.value, consentAt } }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
    return res.json({ success: true, profile: { ...medical.pick(row), shareOnSos: row.shareOnSos === true, updatedAt: row.updatedAt } });
  } catch {
    return res.status(500).json({ success: false, message: "Could not save your medical information." });
  }
};

const deleteMine = async (req, res) => {
  try {
    await MedicalProfile.deleteOne({ userId: req.user.userId });
    return res.json({ success: true, message: "Your medical information was deleted." });
  } catch {
    return res.status(500).json({ success: false, message: "Could not delete your medical information." });
  }
};

module.exports = { getMine, saveMine, deleteMine };
