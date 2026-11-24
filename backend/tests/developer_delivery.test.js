const test = require("node:test");
const assert = require("node:assert/strict");
const { createDeliveryMode, cleanEmails, validMinutes, visibleFilter } = require("../services/delivery_mode");
const { createDeveloperHandlers } = require("../controllers/developer_controller");

const MIN = 60000;
// A fake settings row and a fake user list: "dev@example.com" exists as user "u-dev"; nobody else does.
function fakes({ failRead = false, knownUsers = { "dev@example.com": "u-dev" } } = {}) {
  let row = null;
  const clock = { t: 1_000_000 };
  const settings = {
    findOne: () => ({ lean: async () => { if (failRead) throw new Error("db down"); return row; } }),
    findOneAndUpdate: async (_q, update) => { row = { key: "delivery", value: update.$set.value }; },
  };
  const users = { find: (q) => ({ lean: async () => q.email.$in.filter((e) => knownUsers[e]).map((e) => ({ _id: knownUsers[e] })) }) };
  const mode = createDeliveryMode({ settings, users, now: () => clock.t, cacheMs: 0, idsCacheMs: 0 });
  return { mode, clock };
}

test("the accounts the developer types are cleaned, and bad ones are refused", () => {
  assert.deepEqual(cleanEmails([" Dev@Example.com ", "dev@example.com", "", "b@x.in"]), { ok: true, emails: ["dev@example.com", "b@x.in"] });
  assert.equal(cleanEmails(["not an email"]).ok, false);
  assert.equal(cleanEmails(["a@x.in", "b@x.in", "c@x.in", "d@x.in"]).ok, false, "at most three");
  assert.equal(cleanEmails("a@x.in").ok, false);
});

test("by default everything goes to everyone and nobody is a developer", async () => {
  const { mode } = fakes();
  assert.equal(await mode.privateNow(), false);
  assert.equal(await mode.isDeveloper("u-dev"), false);
  assert.equal((await mode.status()).everyone, true);
});

test("nothing is held back until a test account is saved, and then only that account's sends", async () => {
  const { mode } = fakes();
  await mode.setDevelopers(["dev@example.com"]);
  await mode.setPrivate(120);
  assert.equal(await mode.shouldKeepPrivate("u-dev"), true);
  assert.equal(await mode.shouldKeepPrivate("u-someone-else"), false, "another authority's alert always reaches everyone");
  assert.equal(await mode.shouldKeepPrivate(undefined), false);
});

test("it will not start with no saved account, or with one that does not exist on the server (a test can never go to nobody)", async () => {
  const { mode } = fakes();
  await assert.rejects(() => mode.setPrivate(120), (e) => e.code === "NO_DEVELOPER");
  await mode.setDevelopers(["ghost@example.com"]);
  await assert.rejects(() => mode.setPrivate(30), (e) => e.code === "NO_DEVELOPER");
  assert.equal(await mode.privateNow(), false);
});

test("it switches itself off when the time is up, so a forgotten test never hides a real alert", async () => {
  const { mode, clock } = fakes();
  await mode.setDevelopers(["dev@example.com"]);
  await mode.setPrivate(30);
  clock.t += 29 * MIN;
  assert.equal(await mode.shouldKeepPrivate("u-dev"), true);
  clock.t += 2 * MIN;
  assert.equal(await mode.shouldKeepPrivate("u-dev"), false);
  const s = await mode.status();
  assert.equal(s.everyone, true);
  assert.equal(s.until, null);
});

test("switching back to everyone takes effect at once and keeps the saved accounts", async () => {
  const { mode } = fakes();
  await mode.setDevelopers(["dev@example.com"]);
  await mode.setPrivate(480);
  await mode.setEveryone();
  assert.equal(await mode.privateNow(), false);
  assert.deepEqual((await mode.status({ withAccounts: true })).accounts, ["dev@example.com"]);
  assert.equal((await mode.status()).accounts, undefined, "the plain status never lists the accounts");
});

test("only 30, 120 and 480 minutes (and short test times) are accepted, never longer than a day", async () => {
  const { mode } = fakes();
  assert.equal(validMinutes(30) && validMinutes(120) && validMinutes(480), true);
  assert.equal(validMinutes(2000), false);
  assert.equal(validMinutes(0), false);
  assert.equal(validMinutes(1.5), false);
  await mode.setDevelopers(["dev@example.com"]);
  await assert.rejects(() => mode.setPrivate(1000), RangeError);
});

test("if the setting cannot be read, everyone receives (a failure never holds an alert back)", async () => {
  const { mode } = fakes({ failRead: true });
  assert.equal(await mode.privateNow(), false);
  assert.equal(await mode.shouldKeepPrivate("u-dev"), false);
});

test("when a private period ends, the caller is told exactly once", async () => {
  const { mode, clock } = fakes();
  await mode.setDevelopers(["dev@example.com"]);
  let told = 0;
  await mode.setPrivate(30);
  assert.equal(await mode.watch(async () => { told++; }), false);
  clock.t += 31 * MIN;
  assert.equal(await mode.watch(async () => { told++; }), true);
  assert.equal(await mode.watch(async () => { told++; }), false);
  assert.equal(told, 1);
});

test("a saved test account sees everything; everyone else never sees what was kept private", () => {
  assert.deepEqual(visibleFilter(true), {});
  assert.deepEqual(visibleFilter(false), { developerOnly: { $ne: true } });
});

function res() { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; }

test("an account that is not saved gets a plain 'not found' from the read-only status route; a saved one can look", async () => {
  const { mode } = fakes();
  await mode.setDevelopers(["dev@example.com"]);
  const h = createDeveloperHandlers({ delivery: mode });
  const r = res(); let passed = false;
  await h.requireDeveloper({ user: { userId: "u-other" } }, r, () => { passed = true; });
  assert.equal(passed, false);
  assert.equal(r.code, 404);
  let ok = false;
  await h.requireDeveloper({ user: { userId: "u-dev" } }, res(), () => { ok = true; });
  assert.equal(ok, true);
  const g = res(); await h.getDelivery({}, g);
  assert.equal(g.body.data.developer, true);
  assert.equal(g.body.data.accounts, undefined);
  assert.equal(typeof h.putDelivery, "undefined", "an account cannot change the switch; only the Test Console can");
});
