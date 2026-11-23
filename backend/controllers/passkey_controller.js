const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const User = require("../models/user");
const Passkey = require("../models/passkey");
const PasskeyChallenge = require("../models/passkey_challenge");
const { claimLoginSession, accountStatusMessage } = require("./auth_controller");
const SessionLog = require("../models/session_log");
const { startSession, viaFrom } = require("../services/session_log");
const passkeys = require("../services/passkey_service");

const fail = (res, status, message, extra = {}) => res.status(status).json({ success: false, message, ...extra });

const summary = (p) => ({
    id: String(p._id),
    deviceName: p.deviceName || "A device",
    createdAt: p.createdAt,
    lastUsedAt: p.lastUsedAt,
    backedUp: Boolean(p.backedUp),
});

// A challenge is stored when it is handed out and removed the moment it is used, so an answer works once.
const takeChallenge = (challengeId, purpose, challenge) => {
    if (!mongoose.isValidObjectId(challengeId) || !challenge) return Promise.resolve(null);
    return PasskeyChallenge.findOneAndDelete({ _id: challengeId, purpose, challenge, expiresAt: { $gt: new Date() } });
};

const needsRelyingParty = (req, res) => {
    const rp = passkeys.relyingParty(req);
    if (!rp.rpID) { fail(res, 503, "Passkeys are not set up on this server yet."); return null; }
    return rp;
};

// POST /api/auth/passkey/register/options  (signed in)
const startRegistration = async (req, res) => {
    try {
        const rp = needsRelyingParty(req, res);
        if (!rp) return undefined;
        const user = await User.findById(req.user.userId);
        if (!user) return fail(res, 404, "Account not found.");
        const existing = await Passkey.find({ user: user._id }).lean();
        if (existing.length >= passkeys.MAX_PASSKEYS_PER_PERSON) {
            return fail(res, 409, `You already have ${passkeys.MAX_PASSKEYS_PER_PERSON} passkeys. Remove one before adding another.`);
        }
        const options = await passkeys.registrationOptions({ rp, user, existing });
        const stored = await PasskeyChallenge.create({ challenge: options.challenge, purpose: "register", user: user._id, expiresAt: passkeys.newExpiry() });
        return res.status(200).json({ success: true, challengeId: String(stored._id), options });
    } catch (error) {
        console.error("Passkey registration start error:", error.message);
        return fail(res, 500, "Unable to start creating a passkey. Please try again.");
    }
};

// POST /api/auth/passkey/register/verify  (signed in)
const finishRegistration = async (req, res) => {
    try {
        const rp = needsRelyingParty(req, res);
        if (!rp) return undefined;
        const { challengeId, response, deviceName } = req.body || {};
        if (!response || typeof response !== "object") return fail(res, 400, "The passkey answer is missing.");
        const challenge = passkeys.challengeFrom(response);
        const stored = await takeChallenge(challengeId, "register", challenge);
        if (!stored || String(stored.user) !== String(req.user.userId)) return fail(res, 400, "This passkey request expired. Please try again.");
        const made = await passkeys.finishRegistration({ rp, response, challenge });
        if (!made) return fail(res, 400, "The passkey could not be checked. Please try again.");
        if (await Passkey.exists({ credentialId: made.credentialId })) return fail(res, 409, "This passkey is already saved.");
        const saved = await Passkey.create({
            user: req.user.userId,
            ...made,
            deviceName: String(deviceName || "").trim().slice(0, 60),
        });
        return res.status(201).json({ success: true, message: "Passkey added.", passkey: summary(saved) });
    } catch (error) {
        console.warn("Passkey registration rejected:", error.message);
        return fail(res, 400, "The passkey could not be checked. Please try again.");
    }
};

// POST /api/auth/passkey/login/options  (not signed in)
const startLogin = async (req, res) => {
    try {
        const rp = needsRelyingParty(req, res);
        if (!rp) return undefined;
        const options = await passkeys.authenticationOptions({ rp });
        const stored = await PasskeyChallenge.create({ challenge: options.challenge, purpose: "login", expiresAt: passkeys.newExpiry() });
        return res.status(200).json({ success: true, challengeId: String(stored._id), options });
    } catch (error) {
        console.error("Passkey sign-in start error:", error.message);
        return fail(res, 500, "Unable to start passkey sign-in. Please try again.");
    }
};

// POST /api/auth/passkey/login/verify  (not signed in). Ends like the password sign-in: same account checks, same one-device-at-a-time rule.
const finishLogin = async (req, res) => {
    const unknown = () => fail(res, 401, "This passkey is not recognised. Sign in another way, then add it again from your profile.");
    try {
        const rp = needsRelyingParty(req, res);
        if (!rp) return undefined;
        const { challengeId, response } = req.body || {};
        if (!response || typeof response !== "object" || typeof response.id !== "string") return fail(res, 400, "The passkey answer is missing.");
        const challenge = passkeys.challengeFrom(response);
        const stored = await takeChallenge(challengeId, "login", challenge);
        if (!stored) return fail(res, 400, "This sign-in request expired. Please try again.");
        const passkey = await Passkey.findOne({ credentialId: response.id });
        if (!passkey) return unknown();
        const user = await User.findById(passkey.user);
        if (!user) return unknown();

        const accountStatus = user.accountStatus || "active";
        if (accountStatus !== "active") {
            return fail(res, 403, accountStatusMessage(accountStatus), { code: `ACCOUNT_${accountStatus.toUpperCase()}` });
        }
        if (user.role === "authority" && user.authorityStatus !== "verified") {
            return fail(res, 403, user.authorityStatus === "rejected"
                ? "Your authority application was rejected."
                : "Your authority account is awaiting admin approval.", { authorityStatus: user.authorityStatus });
        }
        const checked = await passkeys.finishAuthentication({ rp, response, challenge, passkey });
        if (!checked) return unknown();

        const sessionId = crypto.randomBytes(32).toString("hex");
        const claimedUser = await claimLoginSession(user._id, sessionId, true);
        if (!claimedUser) {
            return fail(res, 409, `This account has reached its ${user.maxConcurrentSessions || (user.role === "admin" ? 3 : 1)}-device sign-in limit. Sign out on another device or ask an administrator to raise the limit.`, { code: "ACCOUNT_ALREADY_LOGGED_IN" });
        }
        passkey.counter = checked.newCounter;
        passkey.lastUsedAt = new Date();
        await passkey.save();
        await startSession(SessionLog, claimedUser, sessionId, viaFrom(req));
        const token = jwt.sign({ userId: claimedUser._id, role: claimedUser.role, authorityStatus: claimedUser.authorityStatus, sessionId }, process.env.JWT_SECRET, { expiresIn: "7d" });
        return res.status(200).json({
            success: true,
            message: "Login successful.",
            token,
            user: {
                id: claimedUser._id, name: claimedUser.name, email: claimedUser.email, phone: claimedUser.phone,
                role: claimedUser.role, location: claimedUser.location, department: claimedUser.department,
                designation: claimedUser.designation, employeeId: claimedUser.employeeId, authorityStatus: claimedUser.authorityStatus,
            },
        });
    } catch (error) {
        console.warn("Passkey sign-in rejected:", error.message);
        return fail(res, 401, "The passkey could not be checked. Please try again or sign in another way.");
    }
};

// GET /api/auth/passkey  (signed in): the person's own passkeys
const listPasskeys = async (req, res) => {
    try {
        const rows = await Passkey.find({ user: req.user.userId }).sort({ createdAt: -1 }).lean();
        return res.status(200).json({ success: true, passkeys: rows.map(summary) });
    } catch (error) {
        console.error("Passkey list error:", error.message);
        return fail(res, 500, "Unable to load your passkeys.");
    }
};

// DELETE /api/auth/passkey/:id  (signed in): only the person's own
const removePasskey = async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 400, "Invalid passkey.");
        const removed = await Passkey.findOneAndDelete({ _id: req.params.id, user: req.user.userId });
        if (!removed) return fail(res, 404, "Passkey not found.");
        return res.status(200).json({ success: true, message: "Passkey removed." });
    } catch (error) {
        console.error("Passkey remove error:", error.message);
        return fail(res, 500, "Unable to remove the passkey.");
    }
};

// GET /.well-known/assetlinks.json  (public): how Android confirms that this address and the app belong together
const assetLinks = (req, res) => {
    res.set("Cache-Control", "public, max-age=3600");
    res.type("application/json").status(200).send(JSON.stringify(passkeys.assetLinks()));
};

module.exports = { startRegistration, finishRegistration, startLogin, finishLogin, listPasskeys, removePasskey, assetLinks };
