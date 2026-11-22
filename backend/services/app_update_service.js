// What the phone app is told when it asks "is there a newer version?" (GET /api/app/latest). Everything comes from the server's environment, so a new
// version is announced by setting these values on Render; no code change or redeploy of code is needed. With APP_LATEST_VERSION_CODE unset the answer is
// "nothing to offer" and the app simply opens as usual.

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

// Returns the offer, or null when none is configured or what is configured is not safe to offer.
function latest(env = process.env) {
    const versionCode = toInt(env.APP_LATEST_VERSION_CODE);
    const sizeBytes = toInt(env.APP_LATEST_SIZE_BYTES);
    const url = String(env.APP_LATEST_URL || "").trim();
    const sha256 = String(env.APP_LATEST_SHA256 || "").trim().toLowerCase();
    if (!versionCode || !acceptableUrl(url) || !validHash(sha256)) return null;
    if (sizeBytes > MAX_BYTES) return null;
    return {
        versionCode,
        versionName: String(env.APP_LATEST_VERSION_NAME || "").trim().slice(0, 32),
        url,
        sha256,
        sizeBytes,
        notes: String(env.APP_LATEST_NOTES || "").trim().slice(0, 300),
        minVersionCode: toInt(env.APP_MIN_VERSION_CODE),
    };
}

module.exports = { latest, acceptableUrl, validHash, toInt };
