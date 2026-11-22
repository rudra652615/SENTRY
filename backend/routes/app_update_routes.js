const express = require("express");
const { getLatest } = require("../controllers/app_update_controller");
const router = express.Router();

router.get("/latest", getLatest);

module.exports = router;
