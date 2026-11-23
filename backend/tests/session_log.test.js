const test = require("node:test");
const assert = require("node:assert/strict");
const { startSession, endSession, sessionStatus, buildActivity, createActivityHandler, viaFrom } = require("../services/session_log");
const { PRESENCE_WINDOW_MS } = require("../services/presence");

const NOW = Date.parse("2026-11-23T17:00:00Z");
const ago = (ms) => new Date(NOW - ms);
const fakeLog = () => {
    const calls = { updateMany: [], create: [] };
    return { calls, updateMany: async (...a) => { calls.updateMany.push(a); }, create: async (d) => { calls.create.push(d); } };
};

test("the app says so in a header; anything else is the web", () => {
    assert.equal(viaFrom({ headers: { "x-sentry-client": "app" } }), "app");
    assert.equal(viaFrom({ headers: { "x-sentry-client": "APP" } }), "app");
    assert.equal(viaFrom({ headers: {} }), "web");
    assert.equal(viaFrom(null), "web");
});

test("a sign-in closes only lines that are no longer active sessions, as expired, keeps when the person was last seen, and starts a new line", async () => {
    const log = fakeLog();
    const user = { _id: "u1", name: "Ravi Das", email: "r@x.test", role: "citizen", lastSeenAt: ago(5000) };
    await startSession(log, user, "sess-1", "app", new Date(NOW));
    assert.deepEqual(log.calls.updateMany[0][0], { userId: "u1", logoutAt: null, endedBy: null, sessionId: { $nin: ["sess-1"] } });
    assert.equal(log.calls.updateMany[0][1].$set.endedBy, "expired");
    assert.equal(log.calls.updateMany[0][1].$set.lastSeenAt.getTime(), NOW - 5000);
    assert.equal(log.calls.create[0].sessionId, "sess-1");
    assert.equal(log.calls.create[0].via, "app");
    assert.equal(log.calls.create[0].name, "Ravi Das");
});

test("a second device signing in does not close the first device's line", async () => {
    const log = fakeLog();
    const user = { _id: "u1", name: "Ravi", activeSessionIds: ["phone-1", "phone-2"], lastSeenAt: null };
    await startSession(log, user, "phone-2", "app", new Date(NOW));
    assert.deepEqual(log.calls.updateMany[0][0].sessionId.$nin.sort(), ["phone-1", "phone-2"], "both active sessions are kept open");
    assert.equal(log.calls.create[0].sessionId, "phone-2");
});

test("writing the log never stops a sign-in, even if the database fails", async () => {
    const broken = { updateMany: async () => { throw new Error("db down"); }, create: async () => { throw new Error("db down"); } };
    const quiet = console.error; console.error = () => {};
    try {
        await assert.doesNotReject(() => startSession(broken, { _id: "u1" }, "s", "web"));
        await assert.doesNotReject(() => endSession(broken, { sessionId: "s", by: "logout" }));
    } finally { console.error = quiet; }
});

test("a sign-out ends by session; an administrator ends by account; nothing to match does nothing", async () => {
    const log = fakeLog();
    await endSession(log, { sessionId: "sess-1", by: "logout" }, new Date(NOW));
    assert.deepEqual(log.calls.updateMany[0][0], { logoutAt: null, endedBy: null, sessionId: "sess-1" });
    assert.equal(log.calls.updateMany[0][1].$set.endedBy, "logout");
    await endSession(log, { userId: "u9", by: "admin" }, new Date(NOW));
    assert.deepEqual(log.calls.updateMany[1][0], { logoutAt: null, endedBy: null, userId: "u9" });
    assert.equal(log.calls.updateMany[1][1].$set.endedBy, "admin");
    await endSession(log, { by: "admin" });
    assert.equal(log.calls.updateMany.length, 2);
});

test("status words: live, signed in but quiet, signed out, expired", () => {
    assert.equal(sessionStatus({ logoutAt: ago(1000) }, ago(1000), NOW), "signed-out");
    assert.equal(sessionStatus({ endedBy: "expired" }, ago(1000), NOW), "expired");
    assert.equal(sessionStatus({}, ago(PRESENCE_WINDOW_MS - 1000), NOW), "live");
    assert.equal(sessionStatus({}, ago(PRESENCE_WINDOW_MS + 1000), NOW), "signed-in");
    assert.equal(sessionStatus({}, null, NOW), "signed-in");
});

test("the answer counts who is live by role, newest sign-in first, and never says signed out for an expired line", () => {
    const out = buildActivity({
        now: NOW,
        liveUsers: [
            { _id: "a", name: "Anita", email: "a@x", role: "authority", lastSeenAt: ago(12000) },
            { _id: "r", name: "Ravi", email: "r@x", role: "citizen", lastSeenAt: ago(4000) },
            { _id: "s", name: "Asha", email: "s@x", role: "admin", lastSeenAt: ago(1000) },
        ],
        openLogs: [
            { userId: "r", loginAt: ago(13 * 60000), via: "app" },
            { userId: "a", loginAt: ago(32 * 60000), via: "app" },
        ],
        recentLogs: [
            { _id: "l1", userId: "r", name: "Ravi", role: "citizen", loginAt: ago(13 * 60000) },
            { _id: "l2", userId: "i", name: "Imran", role: "citizen", loginAt: ago(90 * 60000), logoutAt: ago(48 * 60000), endedBy: "logout" },
            { _id: "l3", userId: "x", name: "Old", role: "citizen", loginAt: ago(300 * 60000), endedBy: "expired", lastSeenAt: ago(250 * 60000) },
        ],
        seenByUser: { r: ago(4000) },
    });
    assert.deepEqual(out.counts, { total: 3, citizen: 1, authority: 1, admin: 1 });
    assert.deepEqual(out.live.map((p) => p.name), ["Ravi", "Anita", "Asha"], "newest sign-in first; a person with no line sorts last");
    assert.equal(out.live[2].loginAt, null, "signed in before the log existed");
    assert.deepEqual(out.recent.map((p) => p.status), ["live", "signed-out", "expired"]);
    assert.equal(out.recent[2].logoutAt, null);
    assert.equal(out.recent[2].lastSeenAt, ago(250 * 60000).toISOString());
    assert.equal(out.windowSeconds, PRESENCE_WINDOW_MS / 1000);
});

test("nothing is live and nothing is logged: an empty answer, not an error", () => {
    const out = buildActivity({ now: NOW });
    assert.deepEqual(out.live, []);
    assert.deepEqual(out.recent, []);
    assert.equal(out.counts.total, 0);
});

const chain = (rows) => ({ select: () => chain(rows), sort: () => chain(rows), limit: () => chain(rows), lean: async () => rows });
const fakeRes = () => { const r = { code: 0, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };

test("the endpoint answers with the people who are live and the recent sign-ins", async () => {
    const User = { find: () => chain([{ _id: "r", name: "Ravi", email: "r@x", role: "citizen", lastSeenAt: new Date() }]) };
    const SessionLog = { find: () => chain([{ _id: "l1", userId: "r", name: "Ravi", role: "citizen", loginAt: new Date() }]) };
    const res = fakeRes();
    await createActivityHandler(SessionLog, User)({}, res);
    assert.equal(res.code, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.counts.citizen, 1);
    assert.equal(res.body.recent.length, 1);
});

test("the endpoint says so plainly when the database fails", async () => {
    const User = { find: () => { throw new Error("db down"); } };
    const quiet = console.error; console.error = () => {};
    const res = fakeRes();
    try { await createActivityHandler({}, User)({}, res); } finally { console.error = quiet; }
    assert.equal(res.code, 500);
    assert.equal(res.body.success, false);
});
