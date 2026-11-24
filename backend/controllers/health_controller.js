const mongoose = require("mongoose");
const { createSystemHealth } = require("../services/system_health");

// GET /api/admin/health (administrators only).
const health = createSystemHealth({
  mongoose,
  PushToken: require("../models/push_token"),
  MeshDevice: require("../models/mesh_device"),
  MeshMessage: require("../models/mesh_message"),
  Announcement: require("../models/app_announcement"),
  push: require("../services/push_service"),
  hub: require("../services/live_hub"),
});

async function getHealth(req, res) {
  try {
    res.status(200).json({ success: true, data: await health.collect() });
  } catch (error) {
    console.error("Health report failed:", error.message);
    res.status(500).json({ success: false, message: "Could not build the health report." });
  }
}

module.exports = { getHealth };
