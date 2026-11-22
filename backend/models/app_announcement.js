const mongoose = require("mongoose");

// Remembers which app version the server has already announced to phones, so a redeploy or restart never announces the same version twice.
const appAnnouncementSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    versionCode: { type: Number, default: 0 },
    announcedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.models.AppAnnouncement || mongoose.model("AppAnnouncement", appAnnouncementSchema);
