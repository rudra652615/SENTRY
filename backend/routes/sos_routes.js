const express = require("express");
const { list, detail, setHandled } = require("../controllers/sos_controller");
const { protect, authorize } = require("../middlewares/auth_middleware");
const router = express.Router();

// Staff only: the SOS calls citizens sent, and (when shared) their medical information.
router.use(protect, authorize("authority", "admin"));
router.get("/", list);
router.get("/:id", detail);
router.patch("/:id/handled", setHandled);

module.exports = router;
