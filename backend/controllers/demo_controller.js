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
        // In a developer's private test mode the demo signal reaches only the developer's phones.
        const delivery = require("../services/delivery_mode").default;
        const priv = await delivery.privateNow();
        if (priv) await delivery.developerIds();
        const live = hub.publishDemo(data, { developersOnly: priv });
        // Also by push (60 seconds only): a phone that gave up its own live line because push works would never hear a scene otherwise.
        let pushed = 0;
        try { pushed = (await require("../services/push_service").sendDemo(data.scene, data.version, { developersOnly: priv })).sent || 0; } catch (e) { console.warn("[demo] push failed:", e.message); }
        // The same phone can hear it both ways, so the count is the larger of the two, never the sum.
        res.json({ success: true, data, reached: Math.max(live, pushed), live, pushed, audience: priv ? "developer" : "everyone" });
    } catch (error) { next(error); }
}

module.exports = { postTrigger, tooMany };
