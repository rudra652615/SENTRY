const demo = require("../services/demo_service");
const hub = require("../services/live_hub");

// A few presses a minute are plenty for a person; a guessing script is slowed down. Kept in memory: it only has to hold for a minute.
const hits = new Map();
function tooMany(ip, now = Date.now()) {
    const recent = (hits.get(ip) || []).filter((t) => now - t < 60_000);
    recent.push(now);
    hits.set(ip, recent);
    return recent.length > 30;
}

// POST /api/demo/trigger { scene } with the header x-test-key. Off (404) when the server has no test key.
// The scene is sent over the live connection to every citizen phone connected right now, and to no one later.
async function postTrigger(req, res, next) {
    try {
        if (!demo.enabled()) return res.status(404).json({ success: false, message: "Not found." });
        if (tooMany(req.ip)) return res.status(429).json({ success: false, message: "Slow down." });
        if (!demo.keyMatches(req.get("x-test-key"), process.env.DEMO_TEST_KEY)) return res.status(401).json({ success: false, message: "Wrong test key." });
        const scene = typeof req.body?.scene === "string" ? req.body.scene : "";
        const data = await demo.trigger(scene);
        if (!data) return res.status(400).json({ success: false, message: "That scene does not exist.", scenes: demo.SCENES });
        const reached = hub.publishDemo(data);
        res.json({ success: true, data, reached });
    } catch (error) { next(error); }
}

module.exports = { postTrigger, tooMany };
