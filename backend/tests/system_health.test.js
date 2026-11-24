const test = require("node:test");
const assert = require("node:assert/strict");
const { createSystemHealth } = require("../services/system_health");

function build({ dbOk = true, configured = true, last = null, messages = 0, devices = 3, phones = 12, rowUpdate = { versionCode: 14, announcedAt: "2026-11-24T10:00:00Z" } } = {}) {
  const ts = Date.parse("2026-11-24T12:00:00Z");
  return createSystemHealth({
    mongoose: { connection: { db: { admin: () => ({ ping: async () => { if (!dbOk) throw new Error("down"); } }) } } },
    PushToken: { countDocuments: async () => phones },
    MeshDevice: { countDocuments: async () => devices },
    MeshMessage: {
      countDocuments: async () => messages,
      distinct: async () => (messages ? ["d1", "d2"] : []),
      findOne: () => ({ sort: () => ({ lean: async () => (messages ? { receivedAt: new Date(ts - 600000) } : null) }) }),
    },
    Announcement: { findOne: () => ({ lean: async () => rowUpdate }) },
    push: { status: () => ({ configured, last }) },
    hub: { _count: () => 4 },
    now: () => ts, uptime: () => 3 * 86400 + 4 * 3600, env: { RENDER_GIT_COMMIT: "f3b67bf51c7783d2" },
  });
}

test("everything fine: three of three working, with the facts the screen shows", async () => {
  const r = await build({ messages: 126, last: { at: "2026-11-24T11:58:00Z", sent: 148, failed: 0, audience: "everyone" } }).collect();
  assert.equal(r.overall, "working");
  assert.equal(r.working, 3); assert.equal(r.total, 3);
  assert.equal(r.server.version, "f3b67bf");
  assert.equal(r.server.uptimeSeconds, 3 * 86400 + 4 * 3600);
  assert.equal(r.server.database.ok, true);
  assert.equal(r.push.phones, 12);
  assert.equal(r.push.last.sent, 148);
  assert.equal(r.push.update.versionCode, 14);
  assert.equal(r.nearby.messagesToday, 126); assert.equal(r.nearby.activeToday, 2); assert.equal(r.nearby.devices, 3);
  assert.equal(r.live.clients, 4);
});

test("a quiet nearby network (no messages today) is not a fault", async () => {
  const r = await build({ messages: 0, last: { at: "x", sent: 1, failed: 0 } }).collect();
  assert.equal(r.nearby.status, "quiet");
  assert.equal(r.overall, "working");
  assert.equal(r.working, 3);
});

test("push that is not set up needs attention (phones fall back to their own connection)", async () => {
  const r = await build({ configured: false, messages: 5 }).collect();
  assert.equal(r.push.status, "attention");
  assert.equal(r.overall, "attention");
  assert.equal(r.working, 2);
});

test("a last push that failed completely needs attention; some failures do not", async () => {
  assert.equal((await build({ messages: 1, last: { at: "x", sent: 0, failed: 9 } }).collect()).push.status, "attention");
  assert.equal((await build({ messages: 1, last: { at: "x", sent: 100, failed: 3 } }).collect()).push.status, "working");
});

test("database down: the server and the nearby network are down, and the report still comes back", async () => {
  const r = await build({ dbOk: false }).collect();
  assert.equal(r.server.status, "down");
  assert.equal(r.nearby.status, "down");
  assert.equal(r.overall, "down");
  assert.equal(r.push.phones, 0);
});

test("the report holds counts and times only, nothing private", async () => {
  const text = JSON.stringify(await build({ messages: 2 }).collect());
  assert.equal(/token|email|password|name/i.test(text.replace(/"name"/g, "")), false);
});
