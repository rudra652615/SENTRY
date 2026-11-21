const crypto = require("crypto");
const DemoSignal = require("../models/demo_signal");

// The scenes a citizen phone knows how to play for a test or a demo. Anything else is refused. They are for citizen phones only:
// authority and admin phones are never sent them and never play them.
// A scene plays at the moment it is pressed, on the phones that are connected then, and never later: there is no catch-up.
const SCENES = ["critical", "high", "update", "red", "green", "report_verified", "nearby_help", "widgets", "stop"];

// Off unless the server has a test key. The comparison does not leak how much of the key was right.
function keyMatches(given, expected) {
    if (!expected || typeof given !== "string" || given.length === 0) return false;
    const a = crypto.createHash("sha256").update(given).digest();
    const b = crypto.createHash("sha256").update(expected).digest();
    return crypto.timingSafeEqual(a, b);
}

function enabled(env = process.env) {
    return typeof env.DEMO_TEST_KEY === "string" && env.DEMO_TEST_KEY.length >= 12;
}

// Every press takes a new, larger version, so a phone plays each one once even if it is told twice.
async function trigger(scene, now = Date.now()) {
    if (!SCENES.includes(scene)) return null;
    const row = await DemoSignal.findOneAndUpdate(
        { key: "current" },
        { $set: { scene, issuedAt: new Date(now) }, $inc: { version: 1 } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
    return { scene: row.scene, version: row.version, issuedAt: row.issuedAt };
}

module.exports = { SCENES, keyMatches, enabled, trigger };
