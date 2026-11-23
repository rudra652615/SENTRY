// Who is using the app right now, and who signed in and out when. Read only by an administrator (Penpot boards 153 to 155).
// "Right now" reuses the presence heartbeat the app already sends every ~30 s: a person is live while their last heartbeat is newer than the presence window.
// Writing a line must never stop a sign-in: every write here catches its own errors.
const { PRESENCE_WINDOW_MS, onlineCutoff } = require("./presence");

const RECENT_LIMIT = 60;
const ROLES = ["citizen", "authority", "admin"];

// "app" when the Android app says so in its header, otherwise "web".
const viaFrom = (req) => (String(req?.headers?.["x-sentry-client"] || "").toLowerCase() === "app" ? "app" : "web");

const iso = (value) => (value ? new Date(value).toISOString() : null);

// A sign-in. An account may be signed in on several devices at once (activeSessionIds), so a new sign-in never closes another device's line. Only a line
// that is no longer one of the account's active sessions ended without a sign-out (the login token ran out, the app was removed): it is closed as
// "expired" and keeps the last time the person was seen, so it never reads as a sign-out.
async function startSession(SessionLog, user, sessionId, via = "web", now = new Date()) {
    try {
        const keep = [...new Set([sessionId, user.activeSessionId, ...(Array.isArray(user.activeSessionIds) ? user.activeSessionIds : [])].filter(Boolean).map(String))];
        await SessionLog.updateMany(
            { userId: user._id, logoutAt: null, endedBy: null, sessionId: { $nin: keep } },
            { $set: { endedBy: "expired", lastSeenAt: user.lastSeenAt || null } }
        );
        await SessionLog.create({
            userId: user._id,
            sessionId,
            name: user.name || "",
            email: user.email || "",
            role: user.role || "",
            via: via === "app" ? "app" : "web",
            loginAt: now
        });
    } catch (error) {
        console.error("Session log start error:", error.message);
    }
}

// A sign-out. By session when the person signs out, by account when an administrator ends it. Nothing to match means nothing to do.
async function endSession(SessionLog, { sessionId, userId, by }, now = new Date()) {
    try {
        const filter = { logoutAt: null, endedBy: null };
        if (sessionId) filter.sessionId = sessionId;
        else if (userId) filter.userId = userId;
        else return;
        await SessionLog.updateMany(filter, { $set: { logoutAt: now, endedBy: by === "admin" ? "admin" : "logout" } });
    } catch (error) {
        console.error("Session log end error:", error.message);
    }
}

// How a line reads: "live" (open and seen just now), "signed-in" (open, not seen for a while: for example the app is in the background),
// "signed-out" (the person or an administrator ended it), "expired" (it ended without a sign-out).
function sessionStatus(log, lastSeenAt, now = Date.now()) {
    if (log?.logoutAt) return "signed-out";
    if (log?.endedBy === "expired") return "expired";
    const seen = lastSeenAt ? new Date(lastSeenAt).getTime() : 0;
    return seen >= now - PRESENCE_WINDOW_MS ? "live" : "signed-in";
}

// Turns what the database returned into the answer. Plain data in, plain data out, so it can be tested without a database.
function buildActivity({ liveUsers = [], openLogs = [], recentLogs = [], seenByUser = {}, now = Date.now() } = {}) {
    const openByUser = new Map();
    for (const log of openLogs) {
        const key = String(log.userId);
        if (!openByUser.has(key)) openByUser.set(key, log); // newest first, so the first one is the current session
    }
    const live = liveUsers.map((user) => {
        const log = openByUser.get(String(user._id));
        return { userId: String(user._id), name: user.name || "", email: user.email || "", role: user.role || "", loginAt: iso(log?.loginAt), lastSeenAt: iso(user.lastSeenAt), via: log?.via || null };
    }).sort((a, b) => String(b.loginAt || "").localeCompare(String(a.loginAt || "")));
    const counts = { total: live.length };
    for (const role of ROLES) counts[role] = live.filter((person) => person.role === role).length;
    const recent = recentLogs.map((log) => {
        const lastSeenAt = log.lastSeenAt || seenByUser[String(log.userId)] || null;
        return {
            id: String(log._id), userId: String(log.userId), name: log.name || "", email: log.email || "", role: log.role || "", via: log.via || "web",
            loginAt: iso(log.loginAt), logoutAt: iso(log.logoutAt), endedBy: log.endedBy || null, lastSeenAt: iso(lastSeenAt),
            status: sessionStatus(log, lastSeenAt, now)
        };
    });
    return { live, counts, recent, windowSeconds: PRESENCE_WINDOW_MS / 1000, serverTime: new Date(now).toISOString() };
}

function createActivityHandler(SessionLog, User) {
    return async (req, res) => {
        try {
            const now = Date.now();
            const liveUsers = await User.find({
                lastSeenAt: { $gte: onlineCutoff(now) },
                activeSessionId: { $ne: null },
                accountStatus: { $in: ["active", null] }
            }).select("name email role lastSeenAt").lean();
            const ids = liveUsers.map((user) => user._id);
            const openLogs = ids.length ? await SessionLog.find({ userId: { $in: ids }, logoutAt: null, endedBy: null }).sort({ loginAt: -1 }).lean() : [];
            const recentLogs = await SessionLog.find({}).sort({ loginAt: -1 }).limit(RECENT_LIMIT).lean();
            const openIds = [...new Set(recentLogs.filter((log) => !log.logoutAt && !log.endedBy).map((log) => String(log.userId)))];
            const seenUsers = openIds.length ? await User.find({ _id: { $in: openIds } }).select("lastSeenAt").lean() : [];
            const seenByUser = Object.fromEntries(seenUsers.map((user) => [String(user._id), user.lastSeenAt]));
            return res.status(200).json({ success: true, ...buildActivity({ liveUsers, openLogs, recentLogs, seenByUser, now }) });
        } catch (error) {
            console.error("Admin activity error:", error.message);
            return res.status(500).json({ success: false, message: "Could not read who is using the app." });
        }
    };
}

module.exports = { RECENT_LIMIT, viaFrom, startSession, endSession, sessionStatus, buildActivity, createActivityHandler };
