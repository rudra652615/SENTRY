const express = require("express");
const { getMine, saveMine, deleteMine } = require("../controllers/medical_controller");
const { protect, authorize } = require("../middlewares/auth_middleware");
const router = express.Router();

// Citizens only, and only their own record.
router.use(protect, authorize("citizen"));
router.get("/me", getMine);
router.put("/me", saveMine);
router.delete("/me", deleteMine);

module.exports = router;
