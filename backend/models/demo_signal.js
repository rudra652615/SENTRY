const mongoose = require("mongoose");

// The one "demo signal": the last scene the SENETRY Test Console pressed, and a version that goes up with every press. There is only ever one
// row (key "current"). It carries no alert text and no person's data, only the name of a scene the app already knows.
const demoSignalSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true, default: "current" },
    scene: { type: String, default: null },
    version: { type: Number, default: 0 },
    issuedAt: { type: Date, default: null },
});

module.exports = mongoose.models.DemoSignal || mongoose.model("DemoSignal", demoSignalSchema);
