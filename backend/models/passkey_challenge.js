const mongoose = require("mongoose");

// One challenge handed to a device. It can be used once and expires after five minutes, so a captured answer cannot be played again.
const passkeyChallengeSchema = new mongoose.Schema({
    challenge: { type: String, required: true },
    purpose: { type: String, enum: ["register", "login"], required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
});

module.exports = mongoose.models.PasskeyChallenge || mongoose.model("PasskeyChallenge", passkeyChallengeSchema);
