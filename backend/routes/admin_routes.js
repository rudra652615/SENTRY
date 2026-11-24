const express = require("express");
const SessionLog = require("../models/session_log");
const User = require("../models/user");
const { createActivityHandler } = require("../services/session_log");
const router = express.Router();
const {
    getAdminStats,
    getPendingAuthorities,
    getAllAuthorities,
    approveAuthority,
    rejectAuthority,
    getOwnSessionLimit,
    getManagedAccounts,
    forceLogoutAccount,
    setManagedAccountStatus,
    setSessionLimit,
    permanentlyDeleteAccount
} = require("../controllers/admin_controller");
const {
    protect,
    authorizeAdmin
} = require("../middlewares/auth_middleware");
router.get(
    "/stats",
    protect,
    authorizeAdmin,
    getAdminStats
);
router.get(
    "/authorities/pending",
    protect,
    authorizeAdmin,
    getPendingAuthorities
);
router.get(
    "/authorities",
    protect,
    authorizeAdmin,
    getAllAuthorities
);
router.get("/accounts", protect, authorizeAdmin, getManagedAccounts);
// Is the server, push and the nearby network working (the administrator's System health screen).
router.get("/health", protect, authorizeAdmin, require("../controllers/health_controller").getHealth);
// Who is using the app now and who signed in and out when (the administrator's Live screen).
router.get("/activity", protect, authorizeAdmin, createActivityHandler(SessionLog, User));
router.get("/accounts/me/session-limit", protect, authorizeAdmin, getOwnSessionLimit);
router.patch("/accounts/:id/session-limit", protect, authorizeAdmin, setSessionLimit);
router.post("/accounts/:id/force-logout", protect, authorizeAdmin, forceLogoutAccount);
router.patch("/accounts/:id/status", protect, authorizeAdmin, setManagedAccountStatus);
router.delete("/accounts/:id", protect, authorizeAdmin, permanentlyDeleteAccount);
router.patch(
    "/authorities/:id/approve",
    protect,
    authorizeAdmin,
    approveAuthority
);
router.patch(
    "/authorities/:id/reject",
    protect,
    authorizeAdmin,
    rejectAuthority
);
module.exports = router;
