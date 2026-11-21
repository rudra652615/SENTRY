const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");

// The controller is run with small stand-ins for the database, so the whole flow (options -> phone answer -> token) is checked without a server.
const here = (p) => path.join(__dirname, "..", p);
const stub = (rel, exportsValue) => { const id = require.resolve(here(rel)); require.cache[id] = { id, filename: id, loaded: true, exports: exportsValue }; };

const ids = (() => { let n = 0; return () => `6650f1c2a1b2c3d4e5f6${String(++n).padStart(4, "0")}`; })();
const db = { users: new Map(), passkeys: [], challenges: [] };
const matches = (doc, q) => Object.entries(q).every(([k, v]) => (v && typeof v === "object" && "$gt" in v ? doc[k] > v.$gt : String(doc[k]) === String(v)));

stub("models/user.js", { findById: async (id) => db.users.get(String(id)) || null });
stub("models/passkey.js", {
    find: (q) => ({ lean: async () => db.passkeys.filter((p) => matches(p, q)), sort() { return { lean: async () => db.passkeys.filter((p) => matches(p, q)) }; } }),
    findOne: async (q) => db.passkeys.find((p) => matches(p, q)) || null,
    exists: async (q) => (db.passkeys.some((p) => matches(p, q)) ? { _id: 1 } : null),
    create: async (doc) => { const row = { _id: ids(), createdAt: new Date(), lastUsedAt: null, async save() {}, ...doc }; db.passkeys.push(row); return row; },
    findOneAndDelete: async (q) => { const i = db.passkeys.findIndex((p) => matches(p, q)); return i < 0 ? null : db.passkeys.splice(i, 1)[0]; },
});
stub("models/passkey_challenge.js", {
    create: async (doc) => { const row = { _id: ids(), ...doc }; db.challenges.push(row); return row; },
    findOneAndDelete: async (q) => { const i = db.challenges.findIndex((c) => matches(c, q)); return i < 0 ? null : db.challenges.splice(i, 1)[0]; },
});
let sessions = 0;
let limit = 1;
stub("controllers/auth_controller.js", {
    accountStatusMessage: (s) => `status ${s}`,
    claimLoginSession: async (userId) => (sessions >= limit ? null : (sessions++, db.users.get(String(userId)))),
});

process.env.JWT_SECRET = "test-secret";
process.env.ANDROID_CERT_SHA256 = "1A:C9:6E:2D:7F:70:88:A4:66:49:56:31:2F:A9:6F:C1:CC:36:62:C0:00:11:22:33:44:55:66:77:88:99:AA:BB";
process.env.PASSKEY_RP_ID = "sentry.example.com";
const jwt = require("jsonwebtoken");
const controller = require("../controllers/passkey_controller");
const passkeys = require("../services/passkey_service");

const RP = { rpID: "sentry.example.com" };
const ORIGIN = passkeys.apkKeyHashOrigin(process.env.ANDROID_CERT_SHA256);
const sha256 = (d) => crypto.createHash("sha256").update(d).digest();
const head = (major, n) => (n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]));
const cbor = (v) => {
    if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
    if (typeof v === "string") { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
    if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
    return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
};
function phone() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    const credentialId = crypto.randomBytes(32);
    const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
    const cd = (type, challenge) => Buffer.from(JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false }));
    const id = credentialId.toString("base64url");
    return {
        id,
        register(challenge) {
            const attested = Buffer.concat([Buffer.alloc(16), Buffer.from([0, credentialId.length]), credentialId, cose]);
            const authData = Buffer.concat([sha256(RP.rpID), Buffer.from([0x45]), Buffer.alloc(4), attested]);
            const att = cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
            return { id, rawId: id, type: "public-key", response: { clientDataJSON: cd("webauthn.create", challenge).toString("base64url"), attestationObject: att.toString("base64url") }, clientExtensionResults: {} };
        },
        sign(challenge, counter) {
            const authData = Buffer.concat([sha256(RP.rpID), Buffer.from([0x05]), Buffer.from([0, 0, 0, counter])]);
            const data = cd("webauthn.get", challenge);
            const signature = crypto.sign("sha256", Buffer.concat([authData, sha256(data)]), privateKey);
            return { id, rawId: id, type: "public-key", response: { clientDataJSON: data.toString("base64url"), authenticatorData: authData.toString("base64url"), signature: signature.toString("base64url") }, clientExtensionResults: {} };
        },
    };
}

const call = async (handler, req) => {
    const out = { status: 0, body: null, headers: {} };
    const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; }, send(b) { out.body = b; return res; }, set(k, v) { out.headers[k] = v; return res; }, type() { return res; } };
    await handler({ hostname: "sentry.example.com", body: {}, params: {}, ...req }, res);
    return out;
};
const newUser = (extra = {}) => { const u = { _id: ids(), name: "Asha", email: "asha@example.in", role: "citizen", accountStatus: "active", authorityStatus: "not_applicable", ...extra }; db.users.set(String(u._id), u); return u; };

test("a person can add a passkey and then sign in with it", async () => {
    Object.assign(db, { passkeys: [], challenges: [] }); sessions = 0; limit = 1;
    const user = newUser();
    const device = phone();
    const start = await call(controller.startRegistration, { user: { userId: user._id } });
    assert.equal(start.status, 200);
    const made = await call(controller.finishRegistration, { user: { userId: user._id }, body: { challengeId: start.body.challengeId, response: device.register(start.body.options.challenge), deviceName: "SM-M356B" } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.passkey.deviceName, "SM-M356B");
    assert.equal(db.passkeys.length, 1);

    const list = await call(controller.listPasskeys, { user: { userId: user._id } });
    assert.equal(list.body.passkeys.length, 1);

    const login = await call(controller.startLogin, {});
    const answer = device.sign(login.body.options.challenge, 3);
    const signedIn = await call(controller.finishLogin, { body: { challengeId: login.body.challengeId, response: answer } });
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
    assert.equal(signedIn.body.user.email, "asha@example.in");
    const claims = jwt.verify(signedIn.body.token, "test-secret");
    assert.equal(String(claims.userId), String(user._id));
    assert.ok(claims.sessionId.length >= 32);
    assert.equal(db.passkeys[0].counter, 3);
    assert.ok(db.passkeys[0].lastUsedAt);
});

test("an answer can be used once: a copy of it is refused", async () => {
    Object.assign(db, { passkeys: [], challenges: [] }); sessions = 0; limit = 5;
    const user = newUser({ email: "once@example.in" });
    const device = phone();
    const start = await call(controller.startRegistration, { user: { userId: user._id } });
    await call(controller.finishRegistration, { user: { userId: user._id }, body: { challengeId: start.body.challengeId, response: device.register(start.body.options.challenge) } });
    const login = await call(controller.startLogin, {});
    const answer = device.sign(login.body.options.challenge, 1);
    const first = await call(controller.finishLogin, { body: { challengeId: login.body.challengeId, response: answer } });
    const copy = await call(controller.finishLogin, { body: { challengeId: login.body.challengeId, response: answer } });
    assert.equal(first.status, 200);
    assert.equal(copy.status, 400);
});

test("a passkey that is not saved, or belongs to a locked or unapproved account, does not sign in", async () => {
    Object.assign(db, { passkeys: [], challenges: [] }); sessions = 0; limit = 5;
    const stranger = phone();
    let login = await call(controller.startLogin, {});
    let out = await call(controller.finishLogin, { body: { challengeId: login.body.challengeId, response: stranger.sign(login.body.options.challenge, 1) } });
    assert.equal(out.status, 401);

    for (const [extra, status, text] of [[{ accountStatus: "locked" }, 403, /status locked/], [{ role: "authority", authorityStatus: "pending" }, 403, /awaiting admin approval/]]) {
        const user = newUser({ email: `${status}${Math.random()}@example.in`, ...extra });
        const device = phone();
        db.passkeys.push({ _id: ids(), user: user._id, credentialId: device.id, publicKey: "", counter: 0, transports: [], async save() {} });
        login = await call(controller.startLogin, {});
        out = await call(controller.finishLogin, { body: { challengeId: login.body.challengeId, response: device.sign(login.body.options.challenge, 1) } });
        assert.equal(out.status, status);
        assert.match(out.body.message, text);
        assert.equal(out.body.token, undefined);
    }
});

test("the one-device rule still applies, and removing works only for the owner", async () => {
    Object.assign(db, { passkeys: [], challenges: [] }); sessions = 0; limit = 0;
    const user = newUser({ email: "limit@example.in" });
    const device = phone();
    const start = await call(controller.startRegistration, { user: { userId: user._id } });
    const made = await call(controller.finishRegistration, { user: { userId: user._id }, body: { challengeId: start.body.challengeId, response: device.register(start.body.options.challenge) } });
    const login = await call(controller.startLogin, {});
    const blocked = await call(controller.finishLogin, { body: { challengeId: login.body.challengeId, response: device.sign(login.body.options.challenge, 2) } });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, "ACCOUNT_ALREADY_LOGGED_IN");

    const other = newUser({ email: "other@example.in" });
    const notYours = await call(controller.removePasskey, { user: { userId: other._id }, params: { id: made.body.passkey.id } });
    assert.equal(notYours.status, 404);
    const gone = await call(controller.removePasskey, { user: { userId: user._id }, params: { id: made.body.passkey.id } });
    assert.equal(gone.status, 200);
    assert.equal(db.passkeys.length, 0);
});

test("a registration answer for someone else's request, or a wrong challenge, is refused", async () => {
    Object.assign(db, { passkeys: [], challenges: [] }); sessions = 0; limit = 5;
    const a = newUser({ email: "a1@example.in" });
    const b = newUser({ email: "b1@example.in" });
    const device = phone();
    const start = await call(controller.startRegistration, { user: { userId: a._id } });
    const stolen = await call(controller.finishRegistration, { user: { userId: b._id }, body: { challengeId: start.body.challengeId, response: device.register(start.body.options.challenge) } });
    assert.equal(stolen.status, 400);
    const start2 = await call(controller.startRegistration, { user: { userId: a._id } });
    const wrong = await call(controller.finishRegistration, { user: { userId: a._id }, body: { challengeId: start2.body.challengeId, response: device.register("not-the-challenge") } });
    assert.equal(wrong.status, 400);
    assert.equal(db.passkeys.length, 0);
});

test("the address list for Android is served as json", async () => {
    const out = await call(controller.assetLinks, {});
    const links = JSON.parse(out.body);
    assert.equal(links[0].target.package_name, "in.senetry.citizen");
    assert.equal(links[0].target.sha256_cert_fingerprints.length, 1);
    assert.match(out.headers["Cache-Control"], /max-age/);
});
