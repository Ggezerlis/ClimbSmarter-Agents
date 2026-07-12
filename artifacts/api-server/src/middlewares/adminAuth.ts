import { type Request, type Response, type NextFunction } from "express";

// Standalone shared-secret admin auth — completely independent of the end-user
// session system. Protected routes check either the x-admin-token header (for
// programmatic API calls) or the admin_token query parameter (for browser navigation
// to the HTML admin page). The secret is loaded from the ADMIN_SECRET environment
// variable, which must be set before the server starts.
export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    res.status(503).json({ error: "Admin access is not configured on this server." });
    return;
  }

  const token =
    typeof req.headers["x-admin-token"] === "string"
      ? req.headers["x-admin-token"]
      : typeof req.query["admin_token"] === "string"
      ? req.query["admin_token"]
      : undefined;

  if (!token || token !== secret) {
    // Return JSON for API calls; the HTML page sets x-admin-token itself.
    res.status(401).json({ error: "Unauthorized — valid admin token required." });
    return;
  }

  next();
}
