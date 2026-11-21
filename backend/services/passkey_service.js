// Passkeys: sign in with a fingerprint, face or screen lock instead of a password. This file holds the parts that do not touch the database,
// so they can be tested on their own. The routes are in controllers/passkey_controller.js.
//
// How the phone app is recognised: Android signs the request with the app's signing certificate. The server accepts an answer only from an
// origin that matches one of the certificates listed in ANDROID_CERT_SHA256 (comma separated, as shown by `keytool -list -v`). The same list is
// published at /.well-known/assetlinks.json, which is how Android confirms this website and the app belong together.
const {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse,
} = require("@simplewebauthn/server");

const CHALLENGE_MINUTES = 5;
const MAX_PASSKEYS_PER_PERSON = 10;
const DEFAULT_PACKAGE = "in.senetry.citizen";

const toBase64Url = (buffer) => Buffer.from(buffer).toString("base64url");
const fromBase64Url = (text) => new Uint8Array(Buffer.from(String(text), "base64url"));

// "1A:C9:6E:..." -> the bytes of the certificate fingerprint, or null if it is not one.
function fingerprintBytes(text) {
    const hex = String(text || "").trim().replace(/:/g, "");
    return /^[0-9a-fA-F]{64}$/.test(hex) ? Buffer.from(hex, "hex") : null;
}

// The origin Android reports for an app: android:apk-key-hash:<base64url of the certificate's SHA-256>.
const apkKeyHashOrigin = (fingerprint) => {
    const bytes = fingerprintBytes(fingerprint);
    return bytes ? `android:apk-key-hash:${toBase64Url(bytes)}` : null;
};

const certFingerprints = (env = process.env) => String(env.ANDROID_CERT_SHA256 || "")
    .split(",").map((item) => item.trim().toUpperCase()).filter((item) => fingerprintBytes(item));

// The website address a passkey belongs to. Set PASSKEY_RP_ID once and keep it: passkeys made for one address do not work on another.
const relyingParty = (req, env = process.env) => {
    const rpID = String(env.PASSKEY_RP_ID || req?.hostname || "").trim().toLowerCase();
    return { rpID, rpName: env.PASSKEY_RP_NAME || "SENETRY" };
};

const allowedOrigins = (rpID, env = process.env) => [
    ...certFingerprints(env).map(apkKeyHashOrigin),
    ...(rpID ? [`https://${rpID}`] : []),
];

// What Android reads to trust the link between this address and the app. Google Play services only accepts a passkey for the app when both
// relations are listed (get_login_creds alone was refused with "RP ID cannot be validated" on a real phone, although Google's own check said linked).
const assetLinks = (env = process.env) => {
    const fingerprints = certFingerprints(env);
    if (!fingerprints.length) return [];
    return [{
        relation: ["delegate_permission/common.get_login_creds", "delegate_permission/common.handle_all_urls"],
        target: { namespace: "android_app", package_name: env.ANDROID_PACKAGE || DEFAULT_PACKAGE, sha256_cert_fingerprints: fingerprints },
    }];
};

const newExpiry = (now = Date.now()) => new Date(now + CHALLENGE_MINUTES * 60 * 1000);

// ----- registration
async function registrationOptions({ rp, user, existing = [] }) {
    return generateRegistrationOptions({
        rpName: rp.rpName,
        rpID: rp.rpID,
        userName: user.email,
        userDisplayName: user.name || user.email,
        userID: new Uint8Array(Buffer.from(String(user._id))),
        attestationType: "none",
        excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: p.transports })),
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
}

async function finishRegistration({ rp, response, challenge, env = process.env }) {
    const verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: allowedOrigins(rp.rpID, env),
        expectedRPID: rp.rpID,
        requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo) return null;
    const { credential, credentialBackedUp } = verification.registrationInfo;
    return {
        credentialId: credential.id,
        publicKey: toBase64Url(credential.publicKey),
        counter: credential.counter || 0,
        transports: Array.isArray(credential.transports) ? credential.transports : response?.response?.transports || [],
        backedUp: Boolean(credentialBackedUp),
    };
}

// ----- sign in
async function authenticationOptions({ rp }) {
    // No list of allowed credentials: the phone shows the passkeys it has for this address, so nobody has to type an email first.
    return generateAuthenticationOptions({ rpID: rp.rpID, userVerification: "required" });
}

async function finishAuthentication({ rp, response, challenge, passkey, env = process.env }) {
    const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: allowedOrigins(rp.rpID, env),
        expectedRPID: rp.rpID,
        requireUserVerification: true,
        credential: {
            id: passkey.credentialId,
            publicKey: fromBase64Url(passkey.publicKey),
            counter: passkey.counter || 0,
            transports: passkey.transports,
        },
    });
    return verification.verified ? { newCounter: verification.authenticationInfo.newCounter } : null;
}

// The challenge the device signed is inside its own answer; read it so the right stored challenge can be found.
function challengeFrom(response) {
    try {
        const client = JSON.parse(Buffer.from(response.response.clientDataJSON, "base64url").toString("utf8"));
        return typeof client.challenge === "string" ? client.challenge : "";
    } catch {
        return "";
    }
}

module.exports = {
    CHALLENGE_MINUTES,
    MAX_PASSKEYS_PER_PERSON,
    toBase64Url,
    fromBase64Url,
    fingerprintBytes,
    apkKeyHashOrigin,
    certFingerprints,
    relyingParty,
    allowedOrigins,
    assetLinks,
    newExpiry,
    registrationOptions,
    finishRegistration,
    authenticationOptions,
    finishAuthentication,
    challengeFrom,
};
