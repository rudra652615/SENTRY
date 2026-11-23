const mongoose = require("mongoose");
// One line per sign-in: who, when they signed in, and when and how it ended. It feeds the administrator's "Live" screen (Penpot boards 153 to 155).
// Names and e-mails are copied in when the line is written, so an old line still reads right after an account is renamed or removed.
const sessionLogSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    sessionId: { type: String, required: true, index: true },
    name: { type: String, default: "" },
    email: { type: String, default: "" },
    role: { type: String, default: "" },
    // "app" for the Android app, "web" for the website (the app says so in the X-Sentry-Client header).
    via: { type: String, enum: ["app", "web"], default: "web" },
    loginAt: { type: Date, required: true, default: Date.now },
    // Set when the person signs out, or an administrator signs them out, locks, bans or deletes them.
    logoutAt: { type: Date, default: null },
    // "logout" (the person), "admin" (an administrator), "expired" (the session ended without a sign-out: last seen below), or null while open.
    endedBy: { type: String, enum: ["logout", "admin", "expired", null], default: null },
    // The last time the person was seen, copied in when a session ends without a sign-out.
    lastSeenAt: { type: Date, default: null }
});
sessionLogSchema.index({ loginAt: -1 });
// A month of history is plenty, and the table never grows without end.
sessionLogSchema.index({ loginAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });
module.exports = mongoose.models.SessionLog || mongoose.model("SessionLog", sessionLogSchema);
