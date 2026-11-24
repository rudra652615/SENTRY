// The developer's switch, operated from the SENTRY Test Console with the secret test key. The console IS the developer: whoever holds the key.
//   GET /api/demo/delivery  -> who receives what is sent now, and the saved test accounts
//   PUT /api/demo/delivery  { accounts: ["me@example.com"] }                  save "my test account" (up to three e-mails)
//   PUT /api/demo/delivery  { everyone: false, minutes: 30 | 120 | 480 }      only my devices, for that long
//   PUT /api/demo/delivery  { everyone: true }                                back to everyone
// The same checks as the demo buttons: off (404) when the server has no test key, a slow-down limit, a wrong key is refused.
function createDemoDeliveryHandlers({ demo, delivery, tooMany, announce = async () => {}, env = process.env }) {
  // Returns true when the request may go on; otherwise it has answered already.
  function allowed(req, res) {
    if (!demo.enabled()) { res.status(404).json({ success: false, message: "Not found." }); return false; }
    if (tooMany(req.ip)) { res.status(429).json({ success: false, message: "Slow down." }); return false; }
    if (!demo.keyMatches(req.get("x-test-key"), env.DEMO_TEST_KEY)) { res.status(401).json({ success: false, message: "Wrong test key." }); return false; }
    return true;
  }
  const answer = async () => ({ success: true, data: await delivery.status({ withAccounts: true }) });
  return {
    async getDelivery(req, res, next) {
      try {
        if (!allowed(req, res)) return;
        res.status(200).json(await answer());
      } catch (error) { next(error); }
    },
    async putDelivery(req, res, next) {
      try {
        if (!allowed(req, res)) return;
        const body = req.body || {};
        const hasAccounts = Array.isArray(body.accounts);
        const hasSwitch = typeof body.everyone === "boolean";
        if (!hasAccounts && !hasSwitch) return res.status(400).json({ success: false, message: "Send accounts, or everyone true or false." });
        if (hasAccounts) {
          try { await delivery.setDevelopers(body.accounts); } catch { return res.status(400).json({ success: false, message: "Use up to three e-mail addresses. Nothing was changed." }); }
        }
        if (hasSwitch) {
          if (body.everyone) {
            await delivery.setEveryone();
            try { await announce(); } catch { /* the one-minute check retries it */ }
          } else {
            const minutes = body.minutes === undefined ? 120 : Number(body.minutes);
            if (minutes !== 30 && minutes !== 120 && minutes !== 480) return res.status(400).json({ success: false, message: "minutes must be 30, 120 or 480." });
            try { await delivery.setPrivate(minutes); } catch (error) {
              if (error && error.code === "NO_DEVELOPER") return res.status(409).json({ success: false, code: "NO_DEVELOPER", message: "Save your test account first (an account that exists on this server). Nothing was changed." });
              throw error;
            }
          }
        }
        return res.status(200).json(await answer());
      } catch (error) { return next(error); }
    },
  };
}

module.exports = { createDemoDeliveryHandlers };
