// What a saved test account may do about the developer's switch: only LOOK at it (so the Send screen can show "Test mode"). The switch itself is
// operated from the SENTRY Test Console with the secret key (controllers/demo_delivery_controller.js). For any other account every call answers
// "not found", so the screen does not even reveal that it exists.
function createDeveloperHandlers({ delivery }) {
  return {
    async requireDeveloper(req, res, next) {
      const userId = req.user && req.user.userId;
      if (!(await delivery.isDeveloper(userId))) return res.status(404).json({ success: false, message: "Not found." });
      return next();
    },
    async getDelivery(req, res) {
      res.status(200).json({ success: true, data: { developer: true, ...(await delivery.status()) } });
    },
  };
}

module.exports = { createDeveloperHandlers };
