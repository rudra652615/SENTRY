const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const passkeys = require("../services/passkey_service");

// A small pretend phone: makes a key, answers the way Android's credential manager does, so the real checks can run without a device.
const cbor = (value) => {
    if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
    if (typeof value === "string") { const b = Buffer.from(value); return Buffer.concat([head(3, b.length), b]); }
    if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
    if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
    throw new Error("unsupported");
};
const head = (major, n) => (n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]));
const sha256 = (data) => crypto.createHash("sha256").update(data).digest();

const RP = { rpID: "sentry.example.com", rpName: "SENETRY" };
const CERT = "1A:C9:6E:2D:7F:70:88:A4:66:49:56:31:2F:A9:6F:C1:CC:36:62:C0:00:11:22:33:44:55:66:77:88:99:AA:BB";
const ENV = { ANDROID_CERT_SHA256: CERT };
const ORIGIN = passkeys.apkKeyHashOrigin(CERT);

function phone() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    const credentialId = crypto.randomBytes(32);
    const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
    const clientData = (type, challenge, origin) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
    const flags = { up: 0x01, uv: 0x04, at: 0x40 };
    return {
        credentialId,
        register(challenge, { origin = ORIGIN, rpID = RP.rpID, uv = true } = {}) {
            const attested = Buffer.concat([Buffer.alloc(16), Buffer.from([credentialId.length >> 8, credentialId.length & 255]), credentialId, cose]);
            const authData = Buffer.concat([sha256(rpID), Buffer.from([flags.up | (uv ? flags.uv : 0) | flags.at]), Buffer.alloc(4), attested]);
            const attestationObject = cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
            const id = credentialId.toString("base64url");
            return { id, rawId: id, type: "public-key", response: { clientDataJSON: clientData("webauthn.create", challenge, origin).toString("base64url"), attestationObject: attestationObject.toString("base64url"), transports: ["internal"] }, clientExtensionResults: {} };
        },
        sign(challenge, counter, { origin = ORIGIN, rpID = RP.rpID, uv = true } = {}) {
            const authData = Buffer.concat([sha256(rpID), Buffer.from([flags.up | (uv ? flags.uv : 0)]), Buffer.from([counter >>> 24, (counter >>> 16) & 255, (counter >>> 8) & 255, counter & 255])]);
            const cd = clientData("webauthn.get", challenge, origin);
            const signature = crypto.sign("sha256", Buffer.concat([authData, sha256(cd)]), privateKey);
            const id = credentialId.toString("base64url");
            return { id, rawId: id, type: "public-key", response: { clientDataJSON: cd.toString("base64url"), authenticatorData: authData.toString("base64url"), signature: signature.toString("base64url") }, clientExtensionResults: {} };
        },
    };
}

test("the app's origin is made from the certificate fingerprint", () => {
  assert.equal(passkeys.apkKeyHashOrigin(CERT), `android:apk-key-hash:${Buffer.from(CERT.replace(/:/g, ""), "hex").toString("base64url")}`);
  assert.equal(passkeys.apkKeyHashOrigin("not a fingerprint"), null);
  assert.equal(passkeys.apkKeyHashOrigin(""), null);
});

test("the address list for Android lists only real fingerprints", () => {
  assert.deepEqual(passkeys.assetLinks({}), []);
  assert.deepEqual(passkeys.assetLinks({ ANDROID_CERT_SHA256: "junk" }), []);
  const links = passkeys.assetLinks({ ANDROID_CERT_SHA256: `${CERT.toLowerCase()}, junk`, ANDROID_PACKAGE: "in.example.app" });
  assert.equal(links.length, 1);
  assert.deepEqual(links[0].relation, ["delegate_permission/common.get_login_creds", "delegate_permission/common.handle_all_urls"]);
  assert.equal(links[0].target.package_name, "in.example.app");
  assert.deepEqual(links[0].target.sha256_cert_fingerprints, [CERT]);
});

test("the address passkeys belong to comes from the setting first, then the request", () => {
  assert.equal(passkeys.relyingParty({ hostname: "A.example.com" }, {}).rpID, "a.example.com");
  assert.equal(passkeys.relyingParty({ hostname: "a.example.com" }, { PASSKEY_RP_ID: "Fixed.example.com" }).rpID, "fixed.example.com");
  assert.equal(passkeys.relyingParty({}, {}).rpID, "");
  assert.deepEqual(passkeys.allowedOrigins("x.example.com", ENV), [ORIGIN, "https://x.example.com"]);
});

test("a passkey can be created and then used to sign in", async () => {
  const device = phone();
  const options = await passkeys.registrationOptions({ rp: RP, user: { _id: "6650f1c2a1b2c3d4e5f60718", email: "a@b.in", name: "A B" } });
  assert.equal(options.rp.id, RP.rpID);
  assert.equal(options.authenticatorSelection.userVerification, "required");
  assert.equal(options.authenticatorSelection.residentKey, "required");
  const made = await passkeys.finishRegistration({ rp: RP, response: device.register(options.challenge), challenge: options.challenge, env: ENV });
  assert.equal(made.credentialId, device.credentialId.toString("base64url"));
  assert.ok(made.publicKey.length > 20);

  const login = await passkeys.authenticationOptions({ rp: RP });
  assert.equal(login.userVerification, "required");
  const answer = device.sign(login.challenge, 5);
  assert.equal(passkeys.challengeFrom(answer), login.challenge);
  const ok = await passkeys.finishAuthentication({ rp: RP, response: answer, challenge: login.challenge, passkey: { ...made, counter: 0 }, env: ENV });
  assert.equal(ok.newCounter, 5);
});

test("answers from the wrong app, wrong address or without a fingerprint check are refused", async () => {
  const device = phone();
  const options = await passkeys.registrationOptions({ rp: RP, user: { _id: "6650f1c2a1b2c3d4e5f60718", email: "a@b.in", name: "A" } });
  await assert.rejects(() => passkeys.finishRegistration({ rp: RP, response: device.register(options.challenge, { origin: "android:apk-key-hash:AAAA" }), challenge: options.challenge, env: ENV }));
  await assert.rejects(() => passkeys.finishRegistration({ rp: RP, response: device.register(options.challenge, { rpID: "evil.example.com" }), challenge: options.challenge, env: ENV }));
  await assert.rejects(() => passkeys.finishRegistration({ rp: RP, response: device.register(options.challenge, { uv: false }), challenge: options.challenge, env: ENV }));
  await assert.rejects(() => passkeys.finishRegistration({ rp: RP, response: device.register("another-challenge"), challenge: options.challenge, env: ENV }));
});

test("sign-in is refused for another person's key, a wrong challenge, a replayed counter or no fingerprint", async () => {
  const mine = phone();
  const other = phone();
  const options = await passkeys.registrationOptions({ rp: RP, user: { _id: "6650f1c2a1b2c3d4e5f60718", email: "a@b.in", name: "A" } });
  const saved = await passkeys.finishRegistration({ rp: RP, response: mine.register(options.challenge), challenge: options.challenge, env: ENV });
  const login = await passkeys.authenticationOptions({ rp: RP });
  const run = (response, challenge = login.challenge, passkey = saved) => passkeys.finishAuthentication({ rp: RP, response, challenge, passkey, env: ENV });
  // Refused means it throws, or answers "not verified" (null).
  const refused = async (promise, why) => { let out = "accepted"; try { out = await promise; } catch { out = null; } assert.equal(out, null, why); };

  await refused(run(other.sign(login.challenge, 1)), "a different device's answer");
  await refused(run(mine.sign("some-other-challenge", 1)), "an answer to another challenge");
  await refused(run(mine.sign(login.challenge, 1, { uv: false })), "no fingerprint or screen lock");
  await refused(run(mine.sign(login.challenge, 1, { origin: "https://evil.example.com" })), "another website");
  const first = await run(mine.sign(login.challenge, 7));
  assert.equal(first.newCounter, 7);
  await refused(run(mine.sign(login.challenge, 7), login.challenge, { ...saved, counter: 7 }), "a counter that did not go up");
});

test("the challenge is read from the answer, and bad answers give an empty one", () => {
  assert.equal(passkeys.challengeFrom({ response: { clientDataJSON: Buffer.from(JSON.stringify({ challenge: "abc" })).toString("base64url") } }), "abc");
  assert.equal(passkeys.challengeFrom({}), "");
  assert.equal(passkeys.challengeFrom({ response: { clientDataJSON: "!!!" } }), "");
});
