const test = require("node:test");
const assert = require("node:assert/strict");
const { latest, acceptableUrl, validHash } = require("../services/app_update_service");
const { getLatest } = require("../controllers/app_update_controller");

const HASH = "ab".repeat(32);
const env = (extra = {}) => ({ APP_LATEST_VERSION_CODE: "5", APP_LATEST_VERSION_NAME: "1.4", APP_LATEST_URL: "https://example.org/sentry.apk", APP_LATEST_SHA256: HASH, APP_LATEST_SIZE_BYTES: "12000000", APP_LATEST_NOTES: "Faster alerts", ...extra });

test("nothing is offered until a version is configured", () => {
    assert.equal(latest({}), null);
    assert.equal(latest(env({ APP_LATEST_VERSION_CODE: "" })), null);
    assert.equal(latest(env({ APP_LATEST_VERSION_CODE: "abc" })), null);
});

test("a configured version is announced with its link, size and safety hash", () => {
    const offer = latest(env({ APP_MIN_VERSION_CODE: "3" }));
    assert.equal(offer.versionCode, 5);
    assert.equal(offer.versionName, "1.4");
    assert.equal(offer.url, "https://example.org/sentry.apk");
    assert.equal(offer.sha256, HASH);
    assert.equal(offer.sizeBytes, 12000000);
    assert.equal(offer.notes, "Faster alerts");
    assert.equal(offer.minVersionCode, 3);
});

test("an unsafe configuration is never offered", () => {
    assert.equal(latest(env({ APP_LATEST_URL: "http://example.org/sentry.apk" })), null);
    assert.equal(latest(env({ APP_LATEST_URL: "" })), null);
    assert.equal(latest(env({ APP_LATEST_SHA256: "" })), null);
    assert.equal(latest(env({ APP_LATEST_SHA256: "xyz" })), null);
    assert.equal(latest(env({ APP_LATEST_SIZE_BYTES: String(900 * 1024 * 1024) })), null);
});

test("the hash is accepted in either letter case, and the link must be https", () => {
    assert.equal(validHash(HASH.toUpperCase()), true);
    assert.equal(acceptableUrl("https://x.example/a.apk"), true);
    assert.equal(acceptableUrl("ftp://x.example/a.apk"), false);
    assert.equal(acceptableUrl(undefined), false);
});

test("the endpoint answers without a sign-in, with the offer or with null", () => {
    const sent = { headers: {}, body: null, set(k, v) { this.headers[k] = v; }, json(v) { this.body = v; } };
    const saved = { ...process.env };
    try {
        delete process.env.APP_LATEST_VERSION_CODE;
        getLatest({}, sent);
        assert.deepEqual(sent.body, { success: true, data: null });
        Object.assign(process.env, env());
        getLatest({}, sent);
        assert.equal(sent.body.data.versionCode, 5);
        assert.match(sent.headers["Cache-Control"], /max-age/);
    } finally {
        for (const k of Object.keys(process.env)) if (k.startsWith("APP_")) delete process.env[k];
        Object.assign(process.env, saved);
    }
});
