// Per-USER FBA Shipment Plan column-visibility preferences. User-scoped (NOT account data): any authenticated user
// reads/writes ONLY their own saved show/hide choices. GET returns the hidden-column id list; POST replaces it.
// Never touches DataDoe or any source-derived / account table.
import { DashboardAccessError, getDashboardAccess, getFbaPlanColumnPrefs, setFbaPlanColumnPrefs } from "../lib/server/supabase.js";

function bodyOf(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { throw new DashboardAccessError("Request body must be valid JSON.", 400); } }
  return req.body;
}

export default async function handler(req, res) {
  try {
    const access = await getDashboardAccess(req); // authenticates the user; no account permission needed (user-scoped prefs)
    if (!access?.userId) { res.status(401).json({ error: "Authentication required." }); return; }

    if (req.method === "GET") {
      const prefs = await getFbaPlanColumnPrefs({ userId: access.userId });
      res.status(200).json(prefs);
      return;
    }

    if (req.method === "POST") {
      const body = bodyOf(req);
      const hidden = Array.isArray(body.hiddenColumns) ? body.hiddenColumns : null;
      if (!hidden) { res.status(400).json({ error: "hiddenColumns must be an array of column ids." }); return; }
      if (hidden.length > 200) { res.status(400).json({ error: "too many hidden columns." }); return; }
      const saved = await setFbaPlanColumnPrefs({ userId: access.userId, hiddenColumns: hidden.map(String) });
      res.status(200).json(saved);
      return;
    }

    res.status(405).json({ error: "Method not allowed." });
  } catch (error) {
    if (error instanceof DashboardAccessError) { res.status(error.status || 403).json({ error: error.message }); return; }
    res.status(500).json({ error: "FBA plan column-prefs request failed." });
  }
}
