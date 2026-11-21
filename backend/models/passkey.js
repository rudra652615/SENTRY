const mongoose = require("mongoose");

// A passkey a person created on one of their devices. Only the public half is kept here; the private half never leaves the device.
const passkeySchema = new mongoose.Schema(
    {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
        credentialId: { type: String, required: true, unique: true }, // base64url
        publicKey: { type: String, required: true }, // base64url of the COSE public key
        counter: { type: Number, default: 0, min: 0 },
        transports: { type: [String], default: [] },
        backedUp: { type: Boolean, default: false },
        deviceName: { type: String, default: "", trim: true, maxlength: 60 },
        lastUsedAt: { type: Date, default: null },
    },
    { timestamps: true }
);

module.exports = mongoose.models.Passkey || mongoose.model("Passkey", passkeySchema);
