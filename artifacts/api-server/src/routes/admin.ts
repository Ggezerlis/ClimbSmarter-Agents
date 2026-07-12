import { Router, type IRouter, type Request, type Response } from "express";
import { Resend } from "resend";
import { eq, desc } from "drizzle-orm";
import { db, supportTicketsTable } from "@workspace/db";
import { adminAuth } from "../middlewares/adminAuth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// Same Connectors-proxy pattern already used elsewhere in this codebase
// (artifacts/api-server/src/routes/auth.ts, stripeEventHandlers.ts) for
// constructing a Resend client — reused here rather than re-reading a plain
// RESEND_API_KEY env var, to stay consistent with how this app already sends mail.
async function getResendClient(): Promise<Resend | null> {
  try {
    const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
    if (!hostname) return null;
    const xReplitToken = process.env.REPL_IDENTITY
      ? `repl ${process.env.REPL_IDENTITY}`
      : process.env.WEB_REPL_RENEWAL
        ? `depl ${process.env.WEB_REPL_RENEWAL}`
        : null;
    if (!xReplitToken) return null;

    const res = await fetch(
      `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=resend`,
      { headers: { Accept: "application/json", "X-Replit-Token": xReplitToken } },
    );
    const data = (await res.json()) as { items?: { settings?: { api_key?: string } }[] };
    const apiKey = data.items?.[0]?.settings?.api_key;
    if (!apiKey) return null;
    return new Resend(apiKey);
  } catch {
    return null;
  }
}

const CATEGORY_COLORS: Record<string, string> = {
  bug: "#d1242f",
  billing: "#9a6700",
  training_question: "#1a7f37",
  account: "#0969da",
  spam: "#57606a",
  other: "#8250df",
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

router.get("/admin/support", adminAuth, async (req: Request, res: Response) => {
  const statusFilter = typeof req.query.status === "string" ? req.query.status : undefined;
  const adminToken = typeof req.query.admin_token === "string" ? req.query.admin_token : "";

  const tickets = statusFilter
    ? await db
        .select()
        .from(supportTicketsTable)
        .where(eq(supportTicketsTable.status, statusFilter))
        .orderBy(desc(supportTicketsTable.createdAt))
    : await db.select().from(supportTicketsTable).orderBy(desc(supportTicketsTable.createdAt));

  const rows = tickets
    .map((t) => {
      const color = CATEGORY_COLORS[t.category] ?? "#57606a";
      const locked = t.status === "sent" || t.status === "dismissed";
      return `
        <div class="ticket" data-id="${t.id}">
          <div class="ticket-head">
            <span class="badge" style="background:${color}">${escapeHtml(t.category)}</span>
            <span class="status">${escapeHtml(t.status)}</span>
            <strong>${escapeHtml(t.subject)}</strong>
            <span class="from">${escapeHtml(t.senderAddress)}</span>
            <span class="date">${new Date(t.createdAt).toLocaleString()}</span>
          </div>
          <pre class="body">${escapeHtml(t.bodyText).slice(0, 4000)}</pre>
          <textarea class="draft" rows="6" ${locked ? "disabled" : ""}>${escapeHtml(t.draftReply)}</textarea>
          <div class="actions">
            <button onclick="approveSend('${t.id}')" ${locked ? "disabled" : ""}>Approve &amp; Send</button>
            <button onclick="dismiss('${t.id}')" class="secondary" ${locked ? "disabled" : ""}>Dismiss</button>
          </div>
        </div>`;
    })
    .join("\n");

  res.status(200).type("html").send(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>ClimbSmarter Support</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 900px; margin: 24px auto; padding: 0 16px; color: #1a1a1a; }
  h1 { font-size: 20px; }
  .filters a { margin-right: 10px; font-size: 13px; }
  .ticket { border: 1px solid #d0d7de; border-radius: 6px; padding: 12px; margin: 12px 0; }
  .ticket-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; font-size: 13px; }
  .badge { color: #fff; font-size: 11px; padding: 2px 8px; border-radius: 10px; text-transform: uppercase; }
  .status { color: #57606a; text-transform: uppercase; font-size: 11px; }
  .from, .date { color: #57606a; }
  .body { background: #f6f8fa; padding: 8px; border-radius: 4px; white-space: pre-wrap; max-height: 200px; overflow-y: auto; font-size: 12.5px; }
  textarea.draft { width: 100%; box-sizing: border-box; font-family: inherit; font-size: 13px; margin-top: 6px; }
  .actions { margin-top: 8px; display: flex; gap: 8px; }
  button { padding: 6px 12px; border-radius: 6px; border: 1px solid #1f6feb; background: #1f6feb; color: #fff; cursor: pointer; }
  button.secondary { background: #fff; color: #1a1a1a; border-color: #d0d7de; }
  button:disabled { opacity: 0.5; cursor: default; }
</style>
</head>
<body>
<h1>ClimbSmarter Support</h1>
<div class="filters">
  <a href="/admin/support?admin_token=${encodeURIComponent(adminToken)}">all</a>
  <a href="/admin/support?status=new&admin_token=${encodeURIComponent(adminToken)}">new</a>
  <a href="/admin/support?status=drafted&admin_token=${encodeURIComponent(adminToken)}">drafted</a>
  <a href="/admin/support?status=sent&admin_token=${encodeURIComponent(adminToken)}">sent</a>
  <a href="/admin/support?status=dismissed&admin_token=${encodeURIComponent(adminToken)}">dismissed</a>
</div>
${rows || "<p>No tickets.</p>"}
<script>
  const ADMIN_TOKEN = ${JSON.stringify(adminToken)};
  async function approveSend(id) {
    const el = document.querySelector('.ticket[data-id="' + id + '"] textarea.draft');
    const draftReply = el.value;
    const r = await fetch('/api/admin/support/tickets/' + id + '/send', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': ADMIN_TOKEN },
      body: JSON.stringify({ draftReply: draftReply }),
    });
    if (r.ok) { location.reload(); } else { alert('Send failed: ' + (await r.text())); }
  }
  async function dismiss(id) {
    const r = await fetch('/api/admin/support/tickets/' + id + '/dismiss', {
      method: 'PATCH',
      headers: { 'x-admin-token': ADMIN_TOKEN },
    });
    if (r.ok) { location.reload(); } else { alert('Dismiss failed: ' + (await r.text())); }
  }
</script>
</body>
</html>`);
});

router.patch("/api/admin/support/tickets/:id/send", adminAuth, async (req: Request, res: Response) => {
  const { id } = req.params;
  const draftReply = typeof req.body?.draftReply === "string" ? req.body.draftReply : undefined;

  try {
    const [ticket] = await db
      .select()
      .from(supportTicketsTable)
      .where(eq(supportTicketsTable.id, id))
      .limit(1);

    if (!ticket) {
      res.status(404).json({ error: "Ticket not found" });
      return;
    }
    if (ticket.status === "sent" || ticket.status === "dismissed") {
      res.status(409).json({ error: "Ticket already finalized" });
      return;
    }

    const replyText = draftReply ?? ticket.draftReply;
    if (!replyText.trim()) {
      res.status(400).json({ error: "Draft reply is empty" });
      return;
    }

    const resend = await getResendClient();
    if (!resend) {
      logger.error({ ticketId: id }, "admin.send: Resend client unavailable");
      res.status(503).json({ error: "Email sending is not configured" });
      return;
    }

    const headers: Record<string, string> = {};
    if (ticket.messageId) {
      headers["In-Reply-To"] = ticket.messageId;
      headers["References"] = ticket.messageId;
    }

    // The only Resend send-email call in this entire feature. It only runs
    // here, inside this admin-authenticated handler, triggered by an explicit
    // human click on "Approve & Send" — never automatically.
    const sendResult = await resend.emails.send({
      from: "ClimbSmarter Support <support@climbsmarter.app>",
      to: ticket.senderAddress,
      subject: `Re: ${ticket.subject}`,
      text: replyText,
      headers,
    });

    if (sendResult.error) {
      logger.error({ ticketId: id, error: sendResult.error }, "admin.send: Resend send failed");
      res.status(502).json({ error: "Failed to send email" });
      return;
    }

    await db
      .update(supportTicketsTable)
      .set({ status: "sent", sentAt: new Date(), draftReply: replyText })
      .where(eq(supportTicketsTable.id, id));

    logger.info({ ticketId: id }, "admin.send: ticket sent");
    res.status(200).json({ ok: true });
  } catch (err: unknown) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), ticketId: id },
      "admin.send: unexpected error",
    );
    res.status(500).json({ error: "Internal error" });
  }
});

router.patch("/api/admin/support/tickets/:id/dismiss", adminAuth, async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await db
      .update(supportTicketsTable)
      .set({ status: "dismissed" })
      .where(eq(supportTicketsTable.id, id));
    logger.info({ ticketId: id }, "admin.dismiss: ticket dismissed");
    res.status(200).json({ ok: true });
  } catch (err: unknown) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), ticketId: id },
      "admin.dismiss: unexpected error",
    );
    res.status(500).json({ error: "Internal error" });
  }
});

export default router;
