const test = require("node:test");
const assert = require("node:assert/strict");
const medical = require("../services/medical_service");
const sos = require("../services/sos_service");
const quakes = require("../services/earthquake_service");

const HOUR = 3600 * 1000;
const profile = { bloodType: "O+", allergies: "Penicillin", conditions: "Asthma", medicines: "Inhaler", note: "2nd floor", shareOnSos: true };
const message = (over = {}) => ({ envId: "e1", kind: "report", userId: "u1", carrierUserId: null, ts: new Date(), receivedAt: new Date(), body: { incidentType: "sos", severity: "Critical", description: "SOS: asks for help", lat: 26.6, lng: 92.8 }, ...over });

// ---- medical information ------------------------------------------------------------------------------------------------------------------

test("medical information is read strictly: a blood type from the list, short text, sharing only for a real true", () => {
  const ok = medical.clean({ bloodType: "o−", allergies: "  Penicillin\n", conditions: "", medicines: "Insulin", note: "x", shareOnSos: true, evil: "ignored" });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { bloodType: "O-", shareOnSos: true, allergies: "Penicillin", conditions: "", medicines: "Insulin", note: "x" });
  assert.equal(medical.clean({ bloodType: "Z+" }).ok, false);
  assert.equal(medical.clean({ note: "x".repeat(301) }).ok, false);
  assert.equal(medical.clean({ shareOnSos: "true" }).value.shareOnSos, false, "only a real true switches sharing on");
  assert.equal(medical.clean(null).ok, false);
  assert.equal(medical.clean([]).ok, false);
});

test("staff see medical information only when it is shared, not empty, and the SOS is recent", () => {
  const now = Date.now();
  assert.deepEqual(medical.visibleFor(profile, message(), now), { bloodType: "O+", allergies: "Penicillin", conditions: "Asthma", medicines: "Inhaler", note: "2nd floor" });
  assert.equal(medical.visibleFor({ ...profile, shareOnSos: false }, message(), now), null, "not shared");
  assert.equal(medical.visibleFor({ ...profile, shareOnSos: undefined }, message(), now), null, "no consent recorded");
  assert.equal(medical.visibleFor({ shareOnSos: true }, message(), now), null, "nothing in it");
  assert.equal(medical.visibleFor(null, message(), now), null, "no profile");
  assert.equal(medical.visibleFor(profile, message({ ts: new Date(now - 73 * HOUR) }), now), null, "the SOS is too old");
  assert.equal(medical.visibleFor(profile, null, now), null, "no SOS");
});

test("what staff get back holds only the five medical fields, nothing else from the record", () => {
  const shown = medical.visibleFor({ ...profile, _id: "x", userId: "u1", consentAt: new Date(), secret: "s" }, message());
  assert.deepEqual(Object.keys(shown).sort(), ["allergies", "bloodType", "conditions", "medicines", "note"]);
});

// ---- SOS list -----------------------------------------------------------------------------------------------------------------------------

test("only reports of type sos are SOS calls", () => {
  assert.equal(sos.isSos(message()), true);
  assert.equal(sos.isSos(message({ body: { incidentType: "landslide" } })), false);
  assert.equal(sos.isSos(message({ kind: "safe" })), false);
  assert.equal(sos.isSos(null), false);
});

test("what a citizen needs travels in the description and comes back as a list of known words", () => {
  const text = sos.describe(["Medical help", "Trapped", "Hack<script>"]);
  assert.equal(text, "SOS: asks for help. Needs: Medical help, Trapped");
  assert.deepEqual(sos.parseNeeds(text), ["Medical help", "Trapped"]);
  assert.deepEqual(sos.parseNeeds("SOS: asks for help"), []);
  assert.deepEqual(sos.parseNeeds("SOS. Needs: Nonsense, Shelter"), ["Shelter"]);
  assert.equal(sos.describe([]), "SOS: asks for help");
});

test("a list item says whether medical information is shared, and never what it is", () => {
  const withInfo = sos.item(message({ carrierUserId: "u9", handledAt: null }), { name: "Ravi Das", phone: "9876501234" }, profile);
  assert.equal(withInfo.medicalShared, true);
  assert.equal(withInfo.viaNearbyPhone, true);
  assert.equal(withInfo.name, "Ravi Das");
  assert.equal(JSON.stringify(withInfo).includes("Penicillin"), false);
  assert.equal(JSON.stringify(withInfo).includes("O+"), false);
  const without = sos.item(message(), null, { ...profile, shareOnSos: false });
  assert.equal(without.medicalShared, false);
  assert.equal(without.viaNearbyPhone, false);
  assert.equal(without.name, "");
  assert.equal(sos.item(message({ handledAt: new Date() }), null, null).handled, true);
});

// ---- earthquakes --------------------------------------------------------------------------------------------------------------------------

const feature = (id, mag, place, lat, lng, ageMs = 600000) => ({ id, properties: { mag, place, time: Date.now() - ageMs }, geometry: { coordinates: [lng, lat, 10] } });

test("the USGS feed is read, and anything malformed is skipped", () => {
  const list = quakes.parseUsgs({ features: [feature("a", 5.24, "near Tezpur", 26.6, 92.8), { id: "bad", properties: { mag: "x" }, geometry: { coordinates: [] } }, { properties: {} }] });
  assert.equal(list.length, 1);
  assert.equal(list[0].mag, 5.2);
  assert.equal(list[0].lat, 26.6);
  assert.equal(quakes.parseUsgs(null).length, 0);
  assert.match(quakes.feedUrl(Date.now()), /earthquake\.usgs\.gov.*minlatitude=5.*maxlongitude=99/);
});

test("only a big, recent earthquake is worth a push", () => {
  const now = Date.now();
  assert.equal(quakes.alertWorthy({ mag: 5.0, time: new Date(now - HOUR) }, now), true);
  assert.equal(quakes.alertWorthy({ mag: 4.9, time: new Date(now - HOUR) }, now), false);
  assert.equal(quakes.alertWorthy({ mag: 6.1, time: new Date(now - 4 * HOUR) }, now), false, "too old to warn about");
  const data = quakes.pushData({ eventId: "a", mag: 5.2, lat: 26.6, lng: 92.8, place: "near Tezpur", time: new Date(now) });
  assert.ok(Object.values(data).every((v) => typeof v === "string"), "push data is strings only");
  assert.equal(data.type, "quake");
});

test("a new big earthquake is pushed once; a repeat look at the feed pushes nothing", async () => {
  const stored = new Set(); const pushed = []; const marks = [];
  const model = { async updateOne(filter, update) { if (update.$setOnInsert) { const isNew = !stored.has(filter.eventId); stored.add(filter.eventId); return { upsertedCount: isNew ? 1 : 0 }; } marks.push(filter.eventId); return { upsertedCount: 0 }; } };
  const push = { async broadcast(data) { pushed.push(data); return true; } };
  const fetchJson = async () => ({ features: [feature("big", 5.6, "near Tezpur", 26.6, 92.8), feature("small", 4.0, "near Shillong", 25.5, 91.9)] });
  const first = await quakes.refresh({ fetchJson, model, push });
  assert.deepEqual(first, { seen: 2, added: 2, alerted: 1 });
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].id, "big");
  assert.deepEqual(marks, ["big"]);
  const second = await quakes.refresh({ fetchJson, model, push });
  assert.deepEqual(second, { seen: 2, added: 0, alerted: 0 });
  assert.equal(pushed.length, 1, "not announced again");
});

test("when push is not set up the earthquake is still saved and nothing breaks", async () => {
  const model = { async updateOne() { return { upsertedCount: 1 }; } };
  const result = await quakes.refresh({ fetchJson: async () => ({ features: [feature("x", 6.0, "p", 20, 80)] }), model, push: { broadcast: async () => false } });
  assert.deepEqual(result, { seen: 1, added: 1, alerted: 0 });
});
