const { current } = require("../services/app_update_service");

// Public on purpose: the app asks before it has a sign-in, and the answer is the same for everyone.
exports.getLatest = (req, res) => {
    res.set("Cache-Control", "public, max-age=60");
    res.json({ success: true, data: current() });
};
