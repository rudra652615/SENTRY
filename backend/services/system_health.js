// The administrator's "System health" report: is the server working, are push messages working, is the nearby network working.
// Only counts and times; nothing private (no names, no messages, no tokens). Every question is asked on its own, so one failing part
// never hides the others.
const DAY = 24 * 3600 * 1000;
const SEVERITY = { working: 0, quiet: 0, attention: 1, down: 2 };

function createSystemHealth({ mongoose, PushToken, MeshDevice, MeshMessage, Announcement, push, hub, now = () => Date.now(), env = process.env, uptime = () => process.uptime() }) {
  const safe = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } };

  async function database() {
    const started = now();
    try {
      await mongoose.connection.db.admin().ping();
      return { ok: true, ms: Math.max(0, now() - started) };
    } catch {
      return { ok: false, ms: null };
    }
  }

  async function collect() {
    const db = await database();
    const server = { status: db.ok ? "working" : "down", database: db, uptimeSeconds: Math.round(uptime()), version: String(env.RENDER_GIT_COMMIT || "").slice(0, 7) || null };

    const sender = push.status();
    const phones = db.ok ? await safe(() => PushToken.countDocuments({}), 0) : 0;
    const row = db.ok ? await safe(() => Announcement.findOne({ key: "update" }).lean(), null) : null;
    let pushStatus = "working";
    if (!sender.configured) pushStatus = "attention";               // Firebase is not set up: phones use their own connection instead
    else if (sender.last && sender.last.failed > 0 && sender.last.sent === 0) pushStatus = "attention";
    const pushOut = {
      status: pushStatus,
      configured: Boolean(sender.configured),
      phones,
      last: sender.last ? { at: sender.last.at, sent: sender.last.sent, failed: sender.last.failed, audience: sender.last.audience } : null,
      update: row ? { versionCode: row.versionCode, announcedAt: row.announcedAt ? new Date(row.announcedAt).toISOString() : null } : null,
    };

    const since = new Date(now() - DAY);
    let nearby = { status: "down", devices: 0, activeToday: 0, messagesToday: 0, lastMessageAt: null };
    if (db.ok) {
      const devices = await safe(() => MeshDevice.countDocuments({}), 0);
      const messagesToday = await safe(() => MeshMessage.countDocuments({ receivedAt: { $gte: since } }), 0);
      const activeToday = (await safe(() => MeshMessage.distinct("deviceId", { receivedAt: { $gte: since } }), [])).length;
      const last = await safe(() => MeshMessage.findOne({}, { receivedAt: 1 }).sort({ receivedAt: -1 }).lean(), null);
      nearby = { status: messagesToday > 0 ? "working" : "quiet", devices, activeToday, messagesToday, lastMessageAt: last && last.receivedAt ? new Date(last.receivedAt).toISOString() : null };
    }

    const parts = [server, pushOut, nearby];
    const worst = Math.max(...parts.map((p) => SEVERITY[p.status] ?? 1));
    const overall = worst >= 2 ? "down" : worst === 1 ? "attention" : "working";
    const working = parts.filter((p) => (SEVERITY[p.status] ?? 1) === 0).length;
    return { checkedAt: new Date(now()).toISOString(), overall, working, total: parts.length, server, push: pushOut, nearby, live: { clients: hub && hub._count ? hub._count() : 0 } };
  }

  return { collect };
}

module.exports = { createSystemHealth, SEVERITY };
