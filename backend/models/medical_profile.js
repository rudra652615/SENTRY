const mongoose = require("mongoose");

// A citizen's own medical information (blood type, allergies, conditions, medicines, a note for helpers). It is optional, belongs to one account,
// and is shown to staff only when the citizen switched sharing on AND sent an SOS (see medical_service.visibleFor). It is never put in a
// notification, a push, the nearby network or a log.
const medicalProfileSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    bloodType: { type: String, default: "" },
    allergies: { type: String, default: "" },
    conditions: { type: String, default: "" },
    medicines: { type: String, default: "" },
    note: { type: String, default: "" },
    shareOnSos: { type: Boolean, default: false },
    consentAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.models.MedicalProfile || mongoose.model("MedicalProfile", medicalProfileSchema);
