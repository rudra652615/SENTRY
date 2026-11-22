const Earthquake = require("../models/earthquake");
const earthquakes = require("../services/earthquake_service");

// GET /api/earthquakes?days=3 : recent earthquakes for India and nearby, newest first. Each phone works out its own distance.
const recent = async (req, res) => {
  try {
    const days = Math.max(1, Math.min(14, Number.parseInt(req.query.days, 10) || 3));
    const rows = await Earthquake.find({ time: { $gte: new Date(Date.now() - days * 86400000) } }).sort({ time: -1 }).limit(120).lean();
    return res.json({ success: true, earthquakes: rows.map(earthquakes.view) });
  } catch {
    return res.status(500).json({ success: false, message: "Could not load the earthquakes." });
  }
};

module.exports = { recent };
