import {
  DashboardAccessError,
  assertAdmin,
  getDashboardAccess,
  getInitialAdminBootstrapStatus,
  inviteDashboardUser,
  listDashboardUsers,
  updateDashboardUser,
} from "../lib/server/supabase.js";

function bodyFor(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); }
    catch { throw new DashboardAccessError("Request body must be valid JSON.", 400); }
  }
  return req.body;
}

export default async function handler(req, res) {
  try {
    const action = String(req.query.action || "me");

    // A public, non-sensitive boolean used only to hide the one-time bootstrap
    // form after the fixed owner identity has been created.
    if (req.method === "GET" && action === "bootstrap-status") {
      res.status(200).json(await getInitialAdminBootstrapStatus());
      return;
    }

    const access = await getDashboardAccess(req);

    if (req.method === "GET" && action === "me") {
      res.status(200).json({ access });
      return;
    }

    assertAdmin(access);
    if (req.method === "GET" && action === "users") {
      res.status(200).json({ users: await listDashboardUsers() });
      return;
    }

    const body = bodyFor(req);
    if (req.method === "POST" && action === "invite") {
      const invited = await inviteDashboardUser(body);
      res.status(201).json({ user: invited });
      return;
    }
    if (req.method === "PATCH" && action === "user") {
      const user = await updateDashboardUser(body);
      res.status(200).json({ user });
      return;
    }
    res.status(400).json({ error: "Unknown access-management request." });
  } catch (error) {
    const status = error instanceof DashboardAccessError ? error.status : 500;
    res.status(status).json({ error: error instanceof Error ? error.message : "Unexpected access-management error." });
  }
}
