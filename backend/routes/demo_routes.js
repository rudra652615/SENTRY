const express = require("express");
const { postTrigger } = require("../controllers/demo_controller");
const router = express.Router();

// No sign-in: pressing needs the secret test key instead. Phones do not read anything here; they hear the scene on the live connection.
router.post("/trigger", postTrigger);

module.exports = router;
