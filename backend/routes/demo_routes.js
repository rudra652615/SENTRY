const express = require("express");
const { postTrigger, tooMany } = require("../controllers/demo_controller");
const demo = require("../services/demo_service");
const { createDemoDeliveryHandlers } = require("../controllers/demo_delivery_controller");
const router = express.Router();
// The developer's "send to everyone" switch for the Test Console, with the same secret key (see controllers/demo_delivery_controller.js).
const delivery = createDemoDeliveryHandlers({
    demo,
    delivery: require("../services/delivery_mode").default,
    tooMany,
    announce: () => require("../services/push_service").announceUpdate(),
});

// No sign-in: pressing needs the secret test key instead. Phones do not read anything here; they hear the scene on the live connection.
router.post("/trigger", postTrigger);
router.get("/delivery", delivery.getDelivery);
router.put("/delivery", delivery.putDelivery);

module.exports = router;
