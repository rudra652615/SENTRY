const express = require("express");
const { protect } = require("../middlewares/auth_middleware");
const delivery = require("../services/delivery_mode").default;
const { createDeveloperHandlers } = require("../controllers/developer_controller");

const handlers = createDeveloperHandlers({ delivery });

// Read-only: a saved test account can see whether test mode is on. The switch is in the Test Console (/api/demo/delivery).
const router = express.Router();
router.use(protect);
router.get("/delivery", handlers.requireDeveloper, handlers.getDelivery);

module.exports = router;
