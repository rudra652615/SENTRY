const mongoose = require("mongoose");

// One small row per server setting that an administrator or developer can change while the server runs. "delivery" is who receives what a
// developer sends while testing (see services/delivery_mode.js).
const appSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

module.exports = mongoose.models.AppSetting || mongoose.model("AppSetting", appSettingSchema);
