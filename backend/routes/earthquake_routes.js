const express = require("express");
const { recent } = require("../controllers/earthquake_controller");
const { protect } = require("../middlewares/auth_middleware");
const router = express.Router();

// Any signed-in account (citizens, authorities, administrators).
router.get("/", protect, recent);

module.exports = router;
