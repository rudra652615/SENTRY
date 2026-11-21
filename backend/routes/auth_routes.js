const express = require("express");
const {
    signup,
    login,
    oauthLogin,
    logout,
    requestOtp,
    verifyOtp
} = require("../controllers/auth_controller");
const { protect } = require("../middlewares/auth_middleware");
const passkey = require("../controllers/passkey_controller");
const router = express.Router();
router.post("/signup", signup);
router.post("/login", login);
router.post("/oauth", oauthLogin);
router.post("/logout", protect, logout);
router.post("/otp/request", requestOtp);
router.post("/otp/verify", verifyOtp);
// Passkeys: sign in with a fingerprint, face or screen lock.
router.post("/passkey/login/options", passkey.startLogin);
router.post("/passkey/login/verify", passkey.finishLogin);
router.post("/passkey/register/options", protect, passkey.startRegistration);
router.post("/passkey/register/verify", protect, passkey.finishRegistration);
router.get("/passkey", protect, passkey.listPasskeys);
router.delete("/passkey/:id", protect, passkey.removePasskey);
module.exports = router;
