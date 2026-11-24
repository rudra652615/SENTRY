const test = require("node:test");
const assert = require("node:assert/strict");
const { createDemoDeliveryHandlers } = require("../controllers/demo_delivery_controller");
const { createDeliveryMode } = require("../services/delivery_mode");

function setup({ enabled = true, key = "k-123", limited = false } = {}) {
  let row = null;
  const clock = { t: 5_000_000 };
  const delivery = createDeliveryMode({
    settings: { findOne: () => ({ lean: async () => row }), findOneAndUpdate: async (_q, u) => { row = { value: u.$set.value }; } },
    users: { find: (q) => ({ lean: async () => q.email.$in.filter((e) => e === "me@example.com").map(() => ({ _id: "u-me" })) }) },
    now: () => clock.t, cacheMs: 0, idsCacheMs: 0,
  });
  let announced = 0;
  const h = createDemoDeliveryHandlers({
    demo: { enabled: () => enabled, keyMatches: (given, expected) => given === expected },
    delivery, tooMany: () => limited, announce: async () => { announced++; }, env: { DEMO_TEST_KEY: key },
  });
  return { h, delivery, announced: () => announced };
}
const req = (key, body) => ({ ip: "1.1.1.1", body, get: (n) => (n === "x-test-key" ? key : undefined) });
const res = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };

test("with no test key on the server the switch does not exist (404)", async () => {
  const { h } = setup({ enabled: false });
  const r = res(); await h.getDelivery(req("k-123"), r, assert.ifError);
  assert.equal(r.code, 404);
  const p = res(); await h.putDelivery(req("k-123", { everyone: false }), p, assert.ifError);
  assert.equal(p.code, 404);
});

test("a wrong or missing key is refused and changes nothing", async () => {
  const { h, delivery } = setup();
  for (const key of ["nope", undefined, ""]) {
    const r = res(); await h.putDelivery(req(key, { accounts: ["me@example.com"] }), r, assert.ifError);
    assert.equal(r.code, 401);
  }
  assert.deepEqual((await delivery.status({ withAccounts: true })).accounts, []);
});

test("a guessing script is slowed down", async () => {
  const { h } = setup({ limited: true });
  const r = res(); await h.getDelivery(req("k-123"), r, assert.ifError);
  assert.equal(r.code, 429);
});

test("the console saves its test account, then can switch to only my devices and back", async () => {
  const { h, delivery, announced } = setup();
  let r = res(); await h.getDelivery(req("k-123"), r, assert.ifError);
  assert.equal(r.body.data.everyone, true); assert.deepEqual(r.body.data.accounts, []);
  r = res(); await h.putDelivery(req("k-123", { accounts: [" Me@Example.com "] }), r, assert.ifError);
  assert.equal(r.code, 200); assert.deepEqual(r.body.data.accounts, ["me@example.com"]);
  r = res(); await h.putDelivery(req("k-123", { everyone: false, minutes: 30 }), r, assert.ifError);
  assert.equal(r.code, 200); assert.equal(r.body.data.everyone, false); assert.ok(r.body.data.remainingMs > 29 * 60000);
  assert.equal(await delivery.privateNow(), true);
  assert.equal(announced(), 0);
  r = res(); await h.putDelivery(req("k-123", { everyone: true }), r, assert.ifError);
  assert.equal(r.body.data.everyone, true); assert.equal(announced(), 1, "going back to everyone sends the announcement that was kept back");
  assert.deepEqual(r.body.data.accounts, ["me@example.com"], "the saved account stays");
});

test("'only my devices' with no saved account says so and changes nothing (409)", async () => {
  const { h, delivery } = setup();
  let r = res(); await h.putDelivery(req("k-123", { everyone: false, minutes: 30 }), r, assert.ifError);
  assert.equal(r.code, 409); assert.equal(r.body.code, "NO_DEVELOPER");
  r = res(); await h.putDelivery(req("k-123", { accounts: ["nobody@example.com"] }), r, assert.ifError);
  r = res(); await h.putDelivery(req("k-123", { everyone: false, minutes: 30 }), r, assert.ifError);
  assert.equal(r.code, 409, "an e-mail that is not an account on this server does not count");
  assert.equal(await delivery.privateNow(), false);
});

test("no time given means the safe default of 2 hours; odd values and odd accounts are refused", async () => {
  const { h } = setup();
  await h.putDelivery(req("k-123", { accounts: ["me@example.com"] }), res(), assert.ifError);
  let r = res(); await h.putDelivery(req("k-123", { everyone: false }), r, assert.ifError);
  assert.ok(r.body.data.remainingMs > 119 * 60000 && r.body.data.remainingMs <= 120 * 60000);
  for (const bad of [{ everyone: false, minutes: 7 }, { everyone: false, minutes: 99999 }, { minutes: 30 }, { everyone: "no" }, { accounts: ["not an email"] }, { accounts: "me@example.com" }, { accounts: ["a@x.in", "b@x.in", "c@x.in", "d@x.in"] }]) {
    r = res(); await h.putDelivery(req("k-123", bad), r, assert.ifError);
    assert.equal(r.code, 400, JSON.stringify(bad));
  }
});
