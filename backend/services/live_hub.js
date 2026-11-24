// Live updates for the phone app. A phone keeps one request open to GET /api/live. When a notification is saved, the server writes one short
// line to every open request that should hear about it, and the app then asks for its list. Nothing private is in the line.
const clients = new Set();

function add(res, user) {
  const client = { res, user };
  clients.add(client);
  res.on("close", () => clients.delete(client));
  return client;
}

// kind "notification": citizens and everyone else with the app open. kind "citizen-report": only authority and admin.
function publish(kind, filter = () => true) {
  const event = kind === "citizen-report" ? "citizen-report" : "notification";
  for (const c of clients) {
    const role = c.user && c.user.role;
    if (event === "citizen-report" && role !== "authority" && role !== "admin") continue;
    if (!filter(c.user)) continue;
    try { c.res.write(`event: ${event}\ndata: {}\n\n`); } catch { clients.delete(c); }
  }
}

// The SENETRY Test Console: one "demo" line to every citizen phone with the app running. It carries only the scene name and its version.
// Authority and admin phones are never sent it.
function publishDemo(payload, { developersOnly = false } = {}) {
  const delivery = developersOnly ? require("./delivery_mode").default : null;
  const line = `event: demo\ndata: ${JSON.stringify({ scene: payload.scene, version: payload.version })}\n\n`;
  let sent = 0;
  for (const c of clients) {
    if (!c.user || c.user.role !== "citizen") continue;
    if (delivery && !delivery.isDeveloperIdSync(c.user.userId)) continue; // private test mode: only the developer's phones hear it
    try { c.res.write(line); sent += 1; } catch { clients.delete(c); }
  }
  return sent;
}

// Ask the hub to speak when a document of this model is saved. No fields of the document are sent.
function attach(model, kind) {
  model.schema.post("save", (doc) => {
    try {
      if (doc && doc.developerOnly) {
        // Kept private by a developer: only developer accounts hear about it.
        const delivery = require("./delivery_mode").default;
        void delivery.developerIds().then(() => publish(kind, (user) => delivery.isDeveloperIdSync(user && user.userId))).catch(() => {});
      } else {
        publish(kind);
      }
    } catch { /* a failed line must never fail a save */ }
  });
}

module.exports = { add, publish, publishDemo, attach, _count: () => clients.size };
