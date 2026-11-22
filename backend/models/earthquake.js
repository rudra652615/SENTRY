const mongoose = require("mongoose");

// An earthquake from the public USGS feed, for India and the area around it. Deleted after 30 days.
const earthquakeSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true },
    mag: { type: Number, required: true },
    place: { type: String, default: "" },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    depthKm: { type: Number, default: null },
    time: { type: Date, required: true, index: { expireAfterSeconds: 30 * 24 * 3600 } },
    source: { type: String, default: "usgs" },
    alerted: { type: Boolean, default: false },
  },
  { timestamps: false }
);

module.exports = mongoose.models.Earthquake || mongoose.model("Earthquake", earthquakeSchema);
