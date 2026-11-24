const test = require("node:test");
const assert = require("node:assert/strict");
const DemoSignal = require("../models/demo_signal");
const demo = require("../services/demo_service");
const { postTrigger, tooMany } = require("../controllers/demo_controller");
const hub = require("../services/live_hub");

function recorder() {
    return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(v) { this.body = v; return this; } };
}
const req = (key, scene, ip = "9.9.9.9") => ({ ip, body: { scene }, get: (n) => (n.toLowerCase() === "x-test-key" ? key : undefined) });
const savedRow = (scene, version = 1) => ({ lean: async () => ({ scene, version, issuedAt: new Date() }) });

test("the test key is checked without being guessable, and a missing key switches the feature off", () => {
    assert.equal(demo.keyMatches("a-long-secret-key", "a-long-secret-key"), true);
    assert.equal(demo.keyMatches("a-long-secret-kex", "a-long-secret-key"), false);
    assert.equal(demo.keyMatches("", "a-long-secret-key"), false);
    assert.equal(demo.keyMatches(undefined, "a-long-secret-key"), false);
    assert.equal(demo.keyMatches("anything", undefined), false);
    assert.equal(demo.enabled({}), false);
    assert.equal(demo.enabled({ DEMO_TEST_KEY: "short" }), false);
    assert.equal(demo.enabled({ DEMO_TEST_KEY: "twelve-chars-or-more" }), true);
});

test("pressing is refused without the right key, with no key set, and for a scene that does not exist", async () => {
    const saved = process.env.DEMO_TEST_KEY;
    const originalUpdate = DemoSignal.findOneAndUpdate;
    let wrote = 0;
    DemoSignal.findOneAndUpdate = () => { wrote += 1; return savedRow("critical"); };
    try {
        delete process.env.DEMO_TEST_KEY;
        let res = recorder(); await postTrigger(req("whatever-key-123", "critical"), res);
        assert.equal(res.statusCode, 404);
        process.env.DEMO_TEST_KEY = "a-long-secret-key";
        res = recorder(); await postTrigger(req("wrong-key-1234567", "critical", "1.1.1.1"), res);
        assert.equal(res.statusCode, 401);
        res = recorder(); await postTrigger(req("a-long-secret-key", "format-the-disk", "1.1.1.2"), res);
        assert.equal(res.statusCode, 400);
        assert.equal(wrote, 0, "nothing is written for a refused request");
        res = recorder(); await postTrigger(req("a-long-secret-key", "critical", "1.1.1.3"), res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.data.scene, "critical");
        assert.equal(wrote, 1);
    } finally {
        DemoSignal.findOneAndUpdate = originalUpdate;
        if (saved === undefined) delete process.env.DEMO_TEST_KEY; else process.env.DEMO_TEST_KEY = saved;
    }
});

test("a guessing script is slowed down", () => {
    const now = 5_000_000;
    let blocked = false;
    for (let i = 0; i < 40; i++) if (tooMany("7.7.7.7", now + i)) blocked = true;
    assert.equal(blocked, true);
    assert.equal(tooMany("8.8.8.8", now), false);
});

test("a demo line goes to every connected citizen phone and to no authority or admin phone, with nothing but the scene and its version", () => {
    const got = { citizen: [], citizen2: [], citizen3: [], authority: [], admin: [] };
    const fake = (name) => ({ on() {}, write(line) { got[name].push(line); } });
    hub.add(fake("citizen"), { role: "citizen" });
    hub.add(fake("citizen2"), { role: "citizen" });
    hub.add(fake("citizen3"), { role: "citizen" });
    hub.add(fake("authority"), { role: "authority" });
    hub.add(fake("admin"), { role: "admin" });
    const sent = hub.publishDemo({ scene: "critical", version: 4, issuedAt: new Date(), secret: "must-not-leak" });
    assert.equal(sent >= 3, true);
    for (const name of ["citizen", "citizen2", "citizen3"]) assert.equal(got[name][0], 'event: demo\ndata: {"scene":"critical","version":4}\n\n', name);
    assert.equal(got.authority.length, 0);
    assert.equal(got.admin.length, 0);
});

test("there is no way to read an earlier scene later: the server offers no read route and keeps no end time", () => {
    const router = require("../routes/demo_routes");
    const paths = router.stack.map((layer) => `${Object.keys(layer.route.methods).join(",")} ${layer.route.path}`);
    // One route sends a scene and none reads one back. The two /delivery routes are the developer's switch (who receives tests), which holds no scene data.
    assert.deepEqual(paths, ["post /trigger", "get /delivery", "put /delivery"]);
    assert.equal(DemoSignal.schema.path("expiresAt"), undefined);
});

test("every scene the console offers is known, and nothing else is", () => {
    assert.equal(demo.SCENES.includes("new_report"), false);
    for (const s of ["critical", "high", "update", "red", "green", "report_verified", "nearby_help", "widgets", "stop"]) assert.ok(demo.SCENES.includes(s), s);
});

test("a stop is broadcast as a stop", async () => {
    const originalUpdate = DemoSignal.findOneAndUpdate;
    DemoSignal.findOneAndUpdate = (query, update) => ({ lean: async () => ({ scene: update.$set.scene, version: 9, issuedAt: update.$set.issuedAt }) });
    try {
        const sent = await demo.trigger("stop", 1_000_000);
        assert.equal(sent.scene, "stop");
        assert.equal(sent.version, 9);
    } finally { DemoSignal.findOneAndUpdate = originalUpdate; }
});
