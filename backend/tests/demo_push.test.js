const test = require("node:test");
const assert = require("node:assert/strict");
const User = require("../models/user");
const push = require("../services/push_service");

// A fake Firebase and a fake list of phones: u-cit is a citizen, u-auth an authority, u-dev a citizen that is the developer's test account.
function setup() {
  const sent = [];
  const messaging = { sendEachForMulticast: async (m) => { sent.push(m); return { responses: m.tokens.map(() => ({ success: true })) }; } };
  const phones = [{ userId: "u-cit", token: "t-cit" }, { userId: "u-auth", token: "t-auth" }, { userId: "u-dev", token: "t-dev" }];
  const model = {
    // like the real database it returns only the fields that were asked for (the bug this guards against: asking for the token alone)
    find: (q, fields) => ({ lean: async () => (q && q.userId && q.userId.$in ? phones.filter((p) => q.userId.$in.includes(p.userId)) : phones).map((p) => Object.fromEntries(Object.entries(p).filter(([k]) => fields && fields[k]))) }),
    deleteMany: async () => {},
  };
  return { sent, messaging, model };
}
const withRoles = async (fn) => {
  const previous = User.find;
  User.find = (q) => {
    // authority and admin are excluded; a user with no role saved (an older account) counts as a citizen
    assert.deepEqual(q.role, { $nin: ["authority", "admin"] });
    return { lean: async () => ["u-cit", "u-dev"].filter((id) => q._id.$in.map(String).includes(id)).map((id) => ({ _id: id })) };
  };
  try { await fn(); } finally { User.find = previous; }
};

test("a scene goes out as a 60-second push to citizen phones only", async () => {
  const { sent, messaging, model } = setup();
  await withRoles(async () => {
    const r = await push.sendDemo("critical", 7, { messaging, model });
    assert.equal(r.sent, 2, "the authority phone is left out");
  });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].tokens.sort(), ["t-cit", "t-dev"]);
  assert.deepEqual(sent[0].data, { type: "demo", scene: "critical", version: "7" });
  assert.equal(sent[0].android.ttl, 60 * 1000, "a test never plays later than the press");
});

test("in private test mode only the developer's citizen phone gets the push", async () => {
  const { sent, messaging, model } = setup();
  await withRoles(async () => {
    const r = await push.sendDemo("high", 8, { messaging, model, developersOnly: true, developerIds: async () => ["u-dev"] });
    assert.equal(r.sent, 1);
  });
  assert.deepEqual(sent[0].tokens, ["t-dev"], "the other citizen and the authority hear nothing");
});

test("without push set up nothing is sent and nothing fails", async () => {
  const r = await push.sendDemo("critical", 9, { messaging: null });
  assert.equal(r.sent, 0);
});
