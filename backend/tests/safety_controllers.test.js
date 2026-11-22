const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// The real controllers, run against stand-in database models, so what staff are told is tested end to end.
const stub = (rel, exports) => { const id = require.resolve(path.join("..", rel)); require.cache[id] = { id, filename: id, loaded: true, exports }; };
const reply = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(v) { this.body = v; return this; } });
const chain = (rows) => ({ sort() { return this; }, limit() { return this; }, select() { return this; }, lean: async () => rows });
const HOUR = 3600 * 1000;

const state = { messages: [], users: [], profiles: [], access: [], saved: null };
stub("models/mesh_message", {
  find: (q) => chain(state.messages.filter((m) => (q.handledAt === null ? !m.handledAt : q.handledAt ? !!m.handledAt : true))),
  findOne: (q) => chain(state.messages.find((m) => m.envId === q.envId) || null),
  findOneAndUpdate: (q, u) => { const m = state.messages.find((x) => x.envId === q.envId); if (m) Object.assign(m, u.$set); return chain(m || null); },
});
stub("models/user", { find: () => chain(state.users) });
stub("models/medical_profile", {
  find: () => chain(state.profiles),
  findOne: () => chain(state.saved),
  findOneAndUpdate: (q, u) => { state.saved = { ...state.saved, ...u.$set, userId: q.userId, updatedAt: new Date() }; return chain(state.saved); },
  deleteOne: async () => { state.saved = null; },
});
stub("models/medical_access", { create: async (row) => { state.access.push(row); return row; } });
const sosController = require("../controllers/sos_controller");
const medicalController = require("../controllers/medical_controller");

const sosMessage = (over = {}) => ({ envId: "e1", kind: "report", userId: "u1", carrierUserId: null, ts: new Date(), receivedAt: new Date(), body: { incidentType: "sos", description: "SOS: asks for help. Needs: Medical help", lat: 26.6, lng: 92.8 }, ...over });
const profile = { userId: "u1", bloodType: "O+", allergies: "Penicillin", conditions: "", medicines: "", note: "", shareOnSos: true };
const staff = { user: { userId: "staff1" } };

test("an SOS opened by staff shows the shared medical information and records who looked", async () => {
  Object.assign(state, { messages: [sosMessage()], users: [{ _id: "u1", name: "Ravi Das", phone: "9876501234" }], profiles: [profile], access: [] });
  const res = reply();
  await sosController.detail({ ...staff, params: { id: "e1" }, query: {} }, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.medicalState, "shared");
  assert.equal(res.body.medical.bloodType, "O+");
  assert.equal(res.body.sos.name, "Ravi Das");
  assert.deepEqual(res.body.sos.needs, ["Medical help"]);
  assert.equal(state.access.length, 1);
  assert.deepEqual({ who: String(state.access[0].viewerId), whose: String(state.access[0].profileUserId), env: state.access[0].envId }, { who: "staff1", whose: "u1", env: "e1" });
  assert.equal(JSON.stringify(state.access[0]).includes("Penicillin"), false, "the record holds no medical data");
});

test("when the citizen did not share, staff get no medical information and nothing is recorded", async () => {
  Object.assign(state, { messages: [sosMessage()], users: [{ _id: "u1", name: "Ravi Das" }], profiles: [{ ...profile, shareOnSos: false }], access: [] });
  const res = reply();
  await sosController.detail({ ...staff, params: { id: "e1" }, query: {} }, res);
  assert.equal(res.body.medical, null);
  assert.equal(res.body.medicalState, "not-shared");
  assert.equal(JSON.stringify(res.body).includes("Penicillin"), false);
  assert.equal(state.access.length, 0);
});

test("an old SOS no longer opens the medical information", async () => {
  Object.assign(state, { messages: [sosMessage({ ts: new Date(Date.now() - 80 * HOUR) })], users: [], profiles: [profile], access: [] });
  const res = reply();
  await sosController.detail({ ...staff, params: { id: "e1" }, query: {} }, res);
  assert.equal(res.body.medical, null);
  assert.equal(state.access.length, 0);
});

test("a citizen with no medical record is told 'none', and an unknown SOS is a 404", async () => {
  Object.assign(state, { messages: [sosMessage()], users: [], profiles: [], access: [] });
  const res = reply();
  await sosController.detail({ ...staff, params: { id: "e1" }, query: {} }, res);
  assert.equal(res.body.medicalState, "none");
  const missing = reply();
  await sosController.detail({ ...staff, params: { id: "nope" }, query: {} }, missing);
  assert.equal(missing.code, 404);
});

test("the SOS list says whether medical information is shared but never shows it, and can be narrowed to open or handled", async () => {
  Object.assign(state, { messages: [sosMessage({ envId: "a" }), sosMessage({ envId: "b", handledAt: new Date() })], users: [{ _id: "u1", name: "Ravi Das", phone: "1" }], profiles: [profile] });
  const all = reply();
  await sosController.list({ ...staff, query: {} }, all);
  assert.equal(all.body.sos.length, 2);
  assert.equal(all.body.sos[0].medicalShared, true);
  assert.equal(JSON.stringify(all.body).includes("Penicillin"), false);
  const open = reply();
  await sosController.list({ ...staff, query: { state: "open" } }, open);
  assert.deepEqual(open.body.sos.map((s) => s.id), ["a"]);
  const done = reply();
  await sosController.list({ ...staff, query: { state: "handled" } }, done);
  assert.deepEqual(done.body.sos.map((s) => s.id), ["b"]);
});

test("staff can mark an SOS handled and open it again", async () => {
  Object.assign(state, { messages: [sosMessage()] });
  const res = reply();
  await sosController.setHandled({ ...staff, params: { id: "e1" }, body: {} }, res);
  assert.equal(res.body.handled, true);
  assert.ok(state.messages[0].handledAt);
  await sosController.setHandled({ ...staff, params: { id: "e1" }, body: { handled: false } }, reply());
  assert.equal(state.messages[0].handledAt, null);
});

test("a citizen saves, reads and deletes only their own medical information; consent is recorded", async () => {
  state.saved = null;
  const me = { user: { userId: "u7" } };
  const bad = reply();
  await medicalController.saveMine({ ...me, body: { bloodType: "Z" } }, bad);
  assert.equal(bad.code, 400);
  const save = reply();
  await medicalController.saveMine({ ...me, body: { bloodType: "A+", allergies: "Dust", shareOnSos: true } }, save);
  assert.equal(save.body.profile.bloodType, "A+");
  assert.equal(save.body.profile.shareOnSos, true);
  assert.ok(state.saved.consentAt, "the moment of consent is stored");
  assert.equal(String(state.saved.userId), "u7");
  const off = reply();
  await medicalController.saveMine({ ...me, body: { bloodType: "A+", shareOnSos: false } }, off);
  assert.equal(state.saved.consentAt, null, "switching sharing off clears the consent");
  const read = reply();
  await medicalController.getMine(me, read);
  assert.equal(read.body.profile.shareOnSos, false);
  await medicalController.deleteMine(me, reply());
  const gone = reply();
  await medicalController.getMine(me, gone);
  assert.equal(gone.body.profile, null);
});
