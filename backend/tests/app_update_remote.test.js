const test = require("node:test");
const assert = require("node:assert/strict");
const svc = require("../services/app_update_service");

const HASH = "a".repeat(64);
const URL_OK = svc.REMOTE_PREFIX + "v9.9/SENTRY-9.9.apk";
const offerJson = (extra = {}) => ({ versionCode: 20, versionName: "2.0", url: URL_OK, sha256: HASH, sizeBytes: 1000, notes: "New things", ...extra });
const reply = (body, ok = true, status = 200) => async () => ({ ok, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
const env = (code) => ({ APP_LATEST_VERSION_CODE: String(code), APP_LATEST_URL: "https://example.com/a.apk", APP_LATEST_SHA256: HASH, APP_LATEST_SIZE_BYTES: "10", APP_LATEST_VERSION_NAME: "env" });

test.beforeEach(() => svc._reset());

test("a valid release file becomes the offer, and no environment setting is needed", async () => {
  const r = await svc.refresh({ fetchImpl: reply(offerJson()) });
  assert.equal(r.ok, true);
  svc._setRemote(r.offer); // stops current() from looking at the real network in this test
  const o = svc.current({});
  assert.equal(o.versionCode, 20);
  assert.equal(o.url, URL_OK);
  assert.equal(o.notes, "New things");
});

test("the newer version wins, and on a tie the environment setting wins", () => {
  svc._setRemote(svc.fromRemote(offerJson({ versionCode: 20 })));
  assert.equal(svc.current(env(19)).versionCode, 20, "GitHub newer");
  assert.equal(svc.current(env(21)).versionName, "env", "environment newer");
  assert.equal(svc.current(env(20)).versionName, "env", "tie: the explicit setting");
});

test("nothing configured anywhere means nothing to offer", () => {
  svc._setRemote(null);
  assert.equal(svc.current({}), null);
});

test("a file that points outside this repository's own release downloads is refused", async () => {
  for (const url of ["https://evil.example.com/SENTRY.apk", "https://github.com/someone-else/SENTRY/releases/download/v1/a.apk", "http://github.com/rudra652615/SENTRY/releases/download/v1/a.apk"]) {
    const r = await svc.refresh({ fetchImpl: reply(offerJson({ url })) });
    assert.equal(r.ok, false, url);
  }
  svc._setRemote(null);
  assert.equal(svc.current({}), null);
});

test("a bad checksum, a missing version, a huge file or junk is refused", async () => {
  for (const body of [offerJson({ sha256: "nope" }), offerJson({ versionCode: 0 }), offerJson({ sizeBytes: 999999999 }), "not json {", "x".repeat(9000)]) {
    const r = await svc.refresh({ fetchImpl: reply(body) });
    assert.equal(r.ok, false);
  }
});

test("a failed look (offline, no file, error status) keeps the last good offer and never throws", async () => {
  const good = await svc.refresh({ fetchImpl: reply(offerJson()) });
  assert.equal(good.ok, true);
  assert.equal((await svc.refresh({ fetchImpl: async () => { throw new Error("offline"); } })).ok, false);
  assert.equal((await svc.refresh({ fetchImpl: reply("", false, 404) })).ok, false);
  assert.equal(svc.current({}, { now: Date.now() }).versionCode, 20, "still the last good one");
});

test("notes are cut to 300 characters like the environment's", async () => {
  const r = await svc.refresh({ fetchImpl: reply(offerJson({ notes: "n".repeat(500) })) });
  assert.equal(r.offer.notes.length, 300);
});
