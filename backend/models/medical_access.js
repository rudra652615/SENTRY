const mongoose = require("mongoose");

// A record that a member of staff opened someone's shared medical information on an SOS. It holds no medical data, only who, whose and when,
// so a citizen (or an audit) can see that it was looked at. Kept for a year.
const medicalAccessSchema = new mongoose.Schema(
  {
    profileUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    viewerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    envId: { type: String, required: true },
    at: { type: Date, default: Date.now, index: { expireAfterSeconds: 365 * 24 * 3600 } },
  },
  { timestamps: false }
);

module.exports = mongoose.models.MedicalAccess || mongoose.model("MedicalAccess", medicalAccessSchema);
