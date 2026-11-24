const test = require("node:test");
const assert = require("node:assert/strict");
const push = require("../services/push_service");
const hub = require("../services/live_hub");
const UserModel = require("../models/user");
const Setting = require("../models/app_setting");

function tokens(...rows) {
  const asked = [];
  return { asked, model: { find: (q) => { asked.push(q); const list = q && q.userId ? rows.filter((r) => q.userId.$in.includes(r.userId)) : rows; return { lean: async () => list.map((r) => ({ token: r.token })) }; }, deleteMany: async () => {} } };
}
function messaging() { const sent = []; return { sent, sendEachForMulticast: async ({ tokens: t }) => { sent.push(t); return { responses: t.map(() => ({ success: true })) }; } }; }

test("private mode: a push goes to the developer's phones only", async () => {
  const { model } = tokens({ token: "t-dev", userId: "u-dev" }, { token: "t-other", userId: "u-other" });
  const m = messaging();
  await push.sendToAll(m, { model, audience: "developer", developerIds: async () => ["u-dev"] });
  assert.deepEqual(m.sent, [["t-dev"]]);
  assert.equal(push.status().last.audience, "developer");
});

test("with no developer phones registered, a private push goes nowhere (and does not fall back to everyone)", async () => {
  const { model } = tokens({ token: "t-other", userId: "u-other" });
  const m = messaging();
  await push.sendToAll(m, { model, audience: "developer", developerIds: async () => [] });
  assert.deepEqual(m.sent, []);
});

test("a normal push still goes to every phone", async () => {
  const { model } = tokens({ token: "a", userId: "1" }, { token: "b", userId: "2" });
  const m = messaging();
  await push.sendToAll(m, { model });
  assert.deepEqual(m.sent, [["a", "b"]]);
});

test("one push window covers private and public notices: if any is for everyone, everyone gets it", async () => {
  push._reset();
  const { model, asked } = tokens({ token: "a", userId: "1" }, { token: "b", userId: "2" });
  const m = messaging();
  push.ping({ messaging: m, model, delayMs: 5, audience: "developer", developerIds: async () => ["1"] });
  push.ping({ messaging: m, model, delayMs: 5 });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(m.sent, [["a", "b"]]);
  assert.deepEqual(asked[0], {}, "the everyone query was used");
});

test("a window of only private notices goes to the developer alone", async () => {
  push._reset();
  const { model } = tokens({ token: "a", userId: "1" }, { token: "b", userId: "2" });
  const m = messaging();
  push.ping({ messaging: m, model, delayMs: 5, audience: "developer", developerIds: async () => ["1"] });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(m.sent, [["a"]]);
});

test("a new-version announcement during private mode goes to the developer and is NOT recorded, so it still goes to everyone later", async () => {
  push._reset();
  const { model } = tokens({ token: "a", userId: "1" });
  const m = messaging();
  let recorded = 0;
  const record = { findOne: () => ({ lean: async () => null }), findOneAndUpdate: async () => { recorded++; } };
  const r = await push.announceUpdate({ messaging: m, model, record, offer: { versionCode: 20 }, privateNow: async () => true });
  assert.equal(r.audience, "developer");
  assert.equal(recorded, 0);
});

test("a normal announcement is recorded and goes to everyone, as before", async () => {
  push._reset();
  const { model } = tokens({ token: "a", userId: "1" }, { token: "b", userId: "2" });
  const m = messaging();
  let recorded = 0;
  const record = { findOne: () => ({ lean: async () => null }), findOneAndUpdate: async () => { recorded++; } };
  const r = await push.announceUpdate({ messaging: m, model, record, offer: { versionCode: 20 }, privateNow: async () => false });
  assert.equal(r.sent, true);
  assert.equal(recorded, 1);
  assert.deepEqual(m.sent, [["a", "b"]]);
});

function client(user) { const lines = []; const res = { write: (s) => { lines.push(s); }, on: () => {} }; hub.add(res, user); return lines; }

test("the live stream: a private notice is heard by developer phones only", async () => {
  const previousFind = UserModel.find;
  const previousSetting = Setting.findOne;
  Setting.findOne = () => ({ lean: async () => ({ value: { developers: ["dev@example.com"], privateUntil: 0 } }) });
  UserModel.find = () => ({ lean: async () => [{ _id: "u-dev" }] });
  try {
    const delivery = require("../services/delivery_mode").default;
    delivery._reset();
    const dev = client({ userId: "u-dev", role: "citizen" });
    const other = client({ userId: "u-other", role: "citizen" });
    const fakeModel = { schema: { post: (_e, fn) => { fakeModel.fire = fn; } } };
    hub.attach(fakeModel, "notification");
    fakeModel.fire({ developerOnly: true });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(dev.filter((l) => l.startsWith("event: notification")).length, 1);
    assert.equal(other.filter((l) => l.startsWith("event: notification")).length, 0);
    fakeModel.fire({ developerOnly: false });
    assert.equal(other.filter((l) => l.startsWith("event: notification")).length, 1, "a normal notice reaches everyone");
  } finally { UserModel.find = previousFind; Setting.findOne = previousSetting; require("../services/delivery_mode").default._reset(); }
});

test("the Test Console signal in private mode reaches only the developer's citizen phones", async () => {
  const previousFind = UserModel.find;
  const previousSetting = Setting.findOne;
  Setting.findOne = () => ({ lean: async () => ({ value: { developers: ["dev@example.com"], privateUntil: 0 } }) });
  UserModel.find = () => ({ lean: async () => [{ _id: "u-dev" }] });
  try {
    const delivery = require("../services/delivery_mode").default;
    delivery._reset();
    await delivery.developerIds();
    const dev = client({ userId: "u-dev", role: "citizen" });
    const other = client({ userId: "u-other", role: "citizen" });
    const reached = hub.publishDemo({ scene: "red", version: 1 }, { developersOnly: true });
    assert.equal(dev.filter((l) => l.startsWith("event: demo")).length, 1);
    assert.equal(other.filter((l) => l.startsWith("event: demo")).length, 0);
    assert.ok(reached >= 1);
    const everyone = hub.publishDemo({ scene: "red", version: 2 });
    assert.ok(everyone >= 2, "without private mode it reaches every citizen");
  } finally { UserModel.find = previousFind; Setting.findOne = previousSetting; require("../services/delivery_mode").default._reset(); }
});
