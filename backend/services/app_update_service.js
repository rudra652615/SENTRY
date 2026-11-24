// What the phone app is told when it asks "is there a newer version?" (GET /api/app/latest). The offer can come from two places and the NEWER version wins:
//  1. the server's environment (APP_LATEST_* on Render), the original way;
//  2. a small file, latest.json, attached to the newest GitHub Release of rudra652615/SENTRY. Publishing a release with that file announces the new
//     version with no Render edit and no redeploy (a release does not touch the code on main). The server looks for it every few minutes.
// With neither set the answer is "nothing to offer" and the app simply opens as usual.

const MAX_BYTES = 80 * 1024 * 1024;

function toInt(value) {
    const n = Number.parseInt(String(value ?? "").trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

// https only: the phone downloads this file and installs it. (The phone also checks the SHA-256 below before it hands the file to Android.)
function acceptableUrl(url) {
    return typeof url === "string" && /^https:\/\/[^\s/]+\/\S*$/.test(url.trim());
}

function validHash(hex) {
    return typeof hex === "string" && /^[0-9a-f]{64}$/.test(hex.trim().toLowerCase());
}

// Builds the offer from plain fields, or returns null when something is missing or not safe to offer.
function build(f) {
    const versionCode = toInt(f.versionCode);
    const sizeBytes = toInt(f.sizeBytes);
    const url = String(f.url || "").trim();
    const sha256 = String(f.sha256 || "").trim().toLowerCase();
    if (!versionCode || !acceptableUrl(url) || !validHash(sha256)) return null;
    if (sizeBytes > MAX_BYTES) return null;
    return {
        versionCode,
        versionName: String(f.versionName || "").trim().slice(0, 32),
        url,
        sha256,
        sizeBytes,
        notes: String(f.notes || "").trim().slice(0, 300),
        minVersionCode: toInt(f.minVersionCode),
    };
}

// The offer from the server's environment, or null.
function latest(env = process.env) {
    return build({
        versionCode: env.APP_LATEST_VERSION_CODE,
        sizeBytes: env.APP_LATEST_SIZE_BYTES,
        url: env.APP_LATEST_URL,
        sha256: env.APP_LATEST_SHA256,
        versionName: env.APP_LATEST_VERSION_NAME,
        notes: env.APP_LATEST_NOTES,
        minVersionCode: env.APP_MIN_VERSION_CODE,
    });
}

// ---- the offer from the GitHub Release file ----------------------------------------------------------------------------------------------
const REMOTE_URL = "https://github.com/rudra652615/SENTRY/releases/latest/download/latest.json";
// The phone installs the file this points to, so a file from the release must point inside this repository's own release downloads.
const REMOTE_PREFIX = "https://github.com/rudra652615/SENTRY/releases/download/";
const REMOTE_MAX_CHARS = 8192;
const REFRESH_MS = 5 * 60 * 1000;

let remote = null; // the last good offer from GitHub; kept if a later look fails
let remoteAt = 0;

function fromRemote(json) {
    const offer = build(json || {});
    return offer && offer.url.startsWith(REMOTE_PREFIX) ? offer : null;
}

// Looks at the newest release's latest.json. A failed look (offline, no file, bad file) keeps the last good offer and never throws.
async function refresh({ fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
    remoteAt = now;
    try {
        if (typeof fetchImpl !== "function") return { ok: false, reason: "no fetch" };
        const res = await fetchImpl(REMOTE_URL, { redirect: "follow", signal: AbortSignal.timeout(8000), headers: { Accept: "application/json" } });
        if (!res.ok) return { ok: false, reason: "status " + res.status };
        const text = await res.text();
        if (text.length > REMOTE_MAX_CHARS) return { ok: false, reason: "file too large" };
        const offer = fromRemote(JSON.parse(text));
        if (!offer) return { ok: false, reason: "not a valid offer" };
        remote = offer;
        return { ok: true, offer };
    } catch (error) {
        return { ok: false, reason: String(error && error.name || "error") };
    }
}

// The offer to use now: the newer of the environment's and GitHub's. On a tie the environment wins (it is the explicit setting).
// Also starts a look in the background when the last one is old, so the phone's answer is never held up by GitHub.
function current(env = process.env, { now = Date.now(), fetchImpl } = {}) {
    if (now - remoteAt > REFRESH_MS) { remoteAt = now; refresh({ fetchImpl, now }).catch(() => {}); }
    const a = latest(env);
    if (a && remote) return remote.versionCode > a.versionCode ? remote : a;
    return a || remote || null;
}

module.exports = { latest, current, refresh, build, fromRemote, acceptableUrl, validHash, toInt, REMOTE_URL, REMOTE_PREFIX, _reset: () => { remote = null; remoteAt = 0; }, _setRemote: (o) => { remote = o; remoteAt = Date.now(); } };
