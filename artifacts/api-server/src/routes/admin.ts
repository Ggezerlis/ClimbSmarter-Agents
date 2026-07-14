import { Router, type IRouter, type Request, type Response } from "express";
import { Resend } from "resend";
import { eq, desc, inArray } from "drizzle-orm";
import { db, supportTicketsTable, agentEventsTable, agentReportsTable } from "@workspace/db";
import { adminAuth } from "../middlewares/adminAuth";
import { logger } from "../lib/logger";
import { FLEET, logAgentEvent } from "../lib/agentLog";

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

// Ticket badges: which of Hermes' category skills produced the draft.
const AGENT_META: Record<string, { label: string; color: string; icon: string }> = {
  bug: { label: `${FLEET.support.name} · Bug`, color: "#e5484d", icon: "🔨" },
  billing: { label: `${FLEET.support.name} · Billing`, color: "#f5a623", icon: "💳" },
  training_question: { label: `${FLEET.support.name} · Training`, color: "#30a46c", icon: "🧗" },
  account: { label: `${FLEET.support.name} · Account`, color: "#0091ff", icon: "🔑" },
  other: { label: `${FLEET.support.name} · General`, color: "#8e4ec6", icon: "💬" },
  spam: { label: `${FLEET.support.name} · Spam Gate`, color: "#697177", icon: "🛑" },
};

const AGENT_COLORS: Record<string, string> = {
  [FLEET.chief.name]: "#d4a017",
  [FLEET.support.name]: "#1f6feb",
  [FLEET.ops.name]: "#64748b",
  [FLEET.analytics.name]: "#30a46c",
  [FLEET.content.name]: "#8e4ec6",
  [FLEET.research.name]: "#e5484d",
  [FLEET.coder.name]: "#f76b15",
  "George (human)": "#f5a623",
};

const STATUS_META: Record<string, { label: string; color: string }> = {
  new: { label: "New", color: "#0091ff" },
  drafted: { label: "Drafted", color: "#f5a623" },
  sent: { label: "Sent", color: "#30a46c" },
  dismissed: { label: "Dismissed", color: "#697177" },
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function timeAgo(d: Date): string {
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// NOTE: the page lives under /api/ because the production front-end
// (climbsmarter.app) only proxies /api/* to this Express server — anything
// else is swallowed by the SPA's client-side router.
router.get("/api/admin/support", adminAuth, async (req: Request, res: Response) => {
  try {
    const statusFilter = typeof req.query.status === "string" ? req.query.status : undefined;
    const adminToken = typeof req.query.admin_token === "string" ? req.query.admin_token : "";

    const all = await db.select().from(supportTicketsTable).orderBy(desc(supportTicketsTable.createdAt));
    const tickets = statusFilter ? all.filter((t) => t.status === statusFilter) : all;

    const counts: Record<string, number> = { new: 0, drafted: 0, sent: 0, dismissed: 0 };
    for (const t of all) counts[t.status] = (counts[t.status] ?? 0) + 1;

    const tok = encodeURIComponent(adminToken);
    const pill = (href: string, label: string, active: boolean, count?: number) =>
      `<a class="pill${active ? " active" : ""}" href="${href}">${label}${
        count !== undefined ? `<span class="count">${count}</span>` : ""
      }</a>`;

    const cards = tickets
      .map((t) => {
        const agent = AGENT_META[t.category] ?? AGENT_META.other;
        const status = STATUS_META[t.status] ?? STATUS_META.new;
        const locked = t.status === "sent" || t.status === "dismissed";
        return `
      <article class="card" data-id="${t.id}">
        <header>
          <span class="agent" style="--agent:${agent.color}">${agent.icon} ${agent.label}</span>
          <span class="chip" style="--chip:${status.color}">${status.label}</span>
          <span class="when" title="${t.createdAt.toISOString()}">${timeAgo(t.createdAt)}</span>
        </header>
        <h2>${escapeHtml(t.subject)}</h2>
        <div class="sender">${escapeHtml(t.senderAddress)}</div>
        <details ${t.status === "new" || t.status === "drafted" ? "open" : ""}>
          <summary>Message</summary>
          <pre>${escapeHtml(t.bodyText).slice(0, 4000)}</pre>
        </details>
        <label class="draft-label" for="d-${t.id}">Draft reply ${
          t.draftReply ? `<em>· by ${agent.label}</em>` : `<em>· none</em>`
        }</label>
        <textarea id="d-${t.id}" class="draft" rows="6" ${locked ? "disabled" : ""} placeholder="Write a reply…">${escapeHtml(
          t.draftReply,
        )}</textarea>
        <footer>
          <button class="send" onclick="approveSend('${t.id}', this)" ${locked ? "disabled" : ""}>Approve &amp; Send</button>
          <button class="ghost" onclick="dismiss('${t.id}', this)" ${locked ? "disabled" : ""}>Dismiss</button>
          ${t.sentAt ? `<span class="sentat">sent ${timeAgo(t.sentAt)}</span>` : ""}
        </footer>
      </article>`;
      })
      .join("\n");

    res.status(200).type("html").send(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ClimbSmarter Support</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f7f8fa; --panel: #ffffff; --text: #17191c; --muted: #697177;
    --line: #e4e7eb; --accent: #1f6feb; --accent-t: #ffffff; --shadow: 0 1px 3px rgba(0,0,0,.07), 0 8px 24px rgba(0,0,0,.05);
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #101216; --panel: #181b20; --text: #e8eaed; --muted: #8b949e; --line: #2b3138; --shadow: 0 1px 3px rgba(0,0,0,.5); }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.55 -apple-system, "Segoe UI", Roboto, sans-serif; }
  .top { position: sticky; top: 0; z-index: 5; backdrop-filter: blur(10px);
         background: color-mix(in srgb, var(--bg) 82%, transparent); border-bottom: 1px solid var(--line); }
  .top-inner { max-width: 960px; margin: 0 auto; padding: 14px 20px; display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .brand { font-weight: 700; font-size: 16px; letter-spacing: -.2px; }
  .brand b { color: var(--accent); }
  .navlink { font-size: 13px; text-decoration: none; color: var(--accent); border: 1px solid var(--line);
             padding: 5px 12px; border-radius: 999px; }
  .navlink:hover { border-color: var(--accent); }
  .stats { display: flex; gap: 8px; margin-left: auto; }
  .stat { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 4px 12px; text-align: center; }
  .stat b { display: block; font-size: 16px; }
  .stat span { font-size: 10.5px; color: var(--muted); text-transform: uppercase; letter-spacing: .5px; }
  main { max-width: 960px; margin: 0 auto; padding: 18px 20px 60px; }
  .pills { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 18px; }
  .pill { text-decoration: none; color: var(--text); background: var(--panel); border: 1px solid var(--line);
          padding: 6px 14px; border-radius: 999px; font-size: 13px; transition: .15s; }
  .pill:hover { border-color: var(--accent); }
  .pill.active { background: var(--accent); border-color: var(--accent); color: var(--accent-t); }
  .pill .count { margin-left: 6px; opacity: .75; font-size: 11.5px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow);
          padding: 16px 18px; margin-bottom: 16px; }
  .card header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; }
  .agent { font-size: 12px; font-weight: 600; color: var(--agent);
           background: color-mix(in srgb, var(--agent) 12%, transparent);
           border: 1px solid color-mix(in srgb, var(--agent) 35%, transparent);
           padding: 3px 10px; border-radius: 999px; }
  .chip { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: var(--chip);
          background: color-mix(in srgb, var(--chip) 14%, transparent); padding: 3px 9px; border-radius: 6px; }
  .when { margin-left: auto; color: var(--muted); font-size: 12px; }
  .card h2 { margin: 4px 0 2px; font-size: 15.5px; letter-spacing: -.2px; }
  .sender { color: var(--muted); font-size: 12.5px; margin-bottom: 10px; }
  details { border: 1px solid var(--line); border-radius: 10px; margin-bottom: 12px; overflow: hidden; }
  summary { cursor: pointer; padding: 8px 12px; font-size: 12.5px; color: var(--muted); user-select: none; }
  details pre { margin: 0; padding: 10px 12px; border-top: 1px solid var(--line); white-space: pre-wrap;
                max-height: 220px; overflow-y: auto; font-size: 12.5px; background: var(--bg); }
  .draft-label { font-size: 12px; font-weight: 600; display: block; margin-bottom: 5px; }
  .draft-label em { color: var(--muted); font-weight: 400; }
  textarea.draft { width: 100%; resize: vertical; background: var(--bg); color: var(--text);
                   border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; font: inherit; }
  textarea.draft:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  .card footer { display: flex; gap: 10px; align-items: center; margin-top: 12px; }
  button { font: inherit; font-weight: 600; border-radius: 10px; padding: 8px 16px; cursor: pointer; transition: .15s; border: 1px solid transparent; }
  button.send { background: var(--accent); color: var(--accent-t); }
  button.send:hover:not(:disabled) { filter: brightness(1.1); }
  button.ghost { background: transparent; color: var(--text); border-color: var(--line); }
  button.ghost:hover:not(:disabled) { border-color: var(--muted); }
  button:disabled { opacity: .45; cursor: default; }
  .sentat { color: var(--muted); font-size: 12px; margin-left: auto; }
  .empty { text-align: center; color: var(--muted); padding: 60px 0; }
  .empty .big { font-size: 40px; margin-bottom: 8px; }
  #toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%) translateY(80px); opacity: 0;
           background: var(--text); color: var(--bg); padding: 10px 18px; border-radius: 10px; font-weight: 600;
           transition: .25s; pointer-events: none; }
  #toast.show { transform: translateX(-50%); opacity: 1; }
</style>
</head>
<body>
<div class="top"><div class="top-inner">
  <span class="brand">Climb<b>Smarter</b> · Support</span>
  <a class="navlink" href="/api/admin/agents?admin_token=${tok}">🛰️ Agents</a>
  <div class="stats">
    <div class="stat"><b>${counts.new}</b><span>new</span></div>
    <div class="stat"><b>${counts.drafted}</b><span>drafted</span></div>
    <div class="stat"><b>${counts.sent}</b><span>sent</span></div>
    <div class="stat"><b>${counts.dismissed}</b><span>dismissed</span></div>
  </div>
</div></div>
<main>
  <nav class="pills">
    ${pill(`/api/admin/support?admin_token=${tok}`, "All", !statusFilter, all.length)}
    ${pill(`/api/admin/support?status=new&admin_token=${tok}`, "New", statusFilter === "new", counts.new)}
    ${pill(`/api/admin/support?status=drafted&admin_token=${tok}`, "Drafted", statusFilter === "drafted", counts.drafted)}
    ${pill(`/api/admin/support?status=sent&admin_token=${tok}`, "Sent", statusFilter === "sent", counts.sent)}
    ${pill(`/api/admin/support?status=dismissed&admin_token=${tok}`, "Dismissed", statusFilter === "dismissed", counts.dismissed)}
  </nav>
  ${cards || `<div class="empty"><div class="big">🧗</div>No tickets here.<br>When support email arrives, the agents will file it for your review.</div>`}
</main>
<div id="toast"></div>
<script>
  const ADMIN_TOKEN = ${JSON.stringify(adminToken)};
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg; el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2200);
  }
  async function approveSend(id, btn) {
    btn.disabled = true; btn.textContent = 'Sending…';
    const el = document.querySelector('.card[data-id="' + id + '"] textarea.draft');
    try {
      const r = await fetch('/api/admin/support/tickets/' + id + '/send', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': ADMIN_TOKEN },
        body: JSON.stringify({ draftReply: el.value }),
      });
      if (r.ok) { toast('Reply sent ✓'); setTimeout(() => location.reload(), 700); }
      else { toast('Send failed'); btn.disabled = false; btn.innerHTML = 'Approve &amp; Send'; }
    } catch { toast('Network error'); btn.disabled = false; btn.innerHTML = 'Approve &amp; Send'; }
  }
  async function dismiss(id, btn) {
    btn.disabled = true;
    try {
      const r = await fetch('/api/admin/support/tickets/' + id + '/dismiss', {
        method: 'PATCH',
        headers: { 'x-admin-token': ADMIN_TOKEN },
      });
      if (r.ok) { toast('Dismissed'); setTimeout(() => location.reload(), 600); }
      else { toast('Dismiss failed'); btn.disabled = false; }
    } catch { toast('Network error'); btn.disabled = false; }
  }
</script>
</body>
</html>`);
  } catch (err: unknown) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "admin.support: failed to render page",
    );
    res.status(500).send("Internal error");
  }
});

// Fleet dashboard: every agent as a card (status, heartbeat, model, tickets
// handled) plus a live communications-style feed of agent actions. Same
// ADMIN_SECRET gate and /api prefix as the support page.
router.get("/api/admin/agents", adminAuth, async (req: Request, res: Response) => {
  try {
    const adminToken = typeof req.query.admin_token === "string" ? req.query.admin_token : "";
    const tok = encodeURIComponent(adminToken);

    const events = await db
      .select()
      .from(agentEventsTable)
      .orderBy(desc(agentEventsTable.createdAt))
      .limit(100);
    const reports = await db
      .select()
      .from(agentReportsTable)
      .orderBy(desc(agentReportsTable.createdAt))
      .limit(12);

    // Everything currently waiting on a human decision.
    const APPROVAL_AGENTS = [FLEET.coder.name, FLEET.content.name];
    const pendingTickets = await db
      .select({
        id: supportTicketsTable.id,
        subject: supportTicketsTable.subject,
        status: supportTicketsTable.status,
        createdAt: supportTicketsTable.createdAt,
      })
      .from(supportTicketsTable)
      .where(inArray(supportTicketsTable.status, ["new", "drafted"]))
      .orderBy(desc(supportTicketsTable.createdAt))
      .limit(10);
    const pendingReports = await db
      .select()
      .from(agentReportsTable)
      .where(inArray(agentReportsTable.status, ["pending"]))
      .orderBy(desc(agentReportsTable.createdAt))
      .limit(20)
      .then((rows) => rows.filter((r) => APPROVAL_AGENTS.includes(r.agent)));
    const approvalCount = pendingTickets.length + pendingReports.length;

    const now = Date.now();
    const fleet = [FLEET.chief, FLEET.coder, FLEET.support, FLEET.ops, FLEET.analytics, FLEET.content, FLEET.research];

    const agentCards = fleet
      .map((a) => {
        const mine = events.filter((e) => e.agent === a.name);
        const last = mine[0];
        const lastMs = last ? now - last.createdAt.getTime() : Infinity;
        const working = lastMs < 90_000;
        const handled = new Set(mine.filter((e) => e.ticketId).map((e) => e.ticketId)).size;
        const color = AGENT_COLORS[a.name] ?? "#697177";
        return `
      <article class="agent-card" style="--agent:${color}">
        <header>
          <span class="avatar">${a.icon}</span>
          <div class="who"><b>${a.name}</b><span>${a.role}</span></div>
          <span class="dot ${working ? "on" : ""}" title="${working ? "Working" : "Idle"}"></span>
        </header>
        <dl>
          <div><dt>Status</dt><dd class="${working ? "working" : "idle"}">${working ? "Working" : "Idle"}</dd></div>
          <div><dt>Heartbeat</dt><dd>${last ? timeAgo(last.createdAt) : "—"}</dd></div>
          <div><dt>Model</dt><dd>Sonnet 4.6</dd></div>
          <div><dt>Tickets</dt><dd>${handled}</dd></div>
        </dl>
      </article>`;
      })
      .join("\n");

    const feed = events
      .slice(0, 40)
      .map((e) => {
        const color = AGENT_COLORS[e.agent] ?? "#697177";
        return `
      <div class="evt">
        <span class="evt-agent" style="--agent:${color}">${escapeHtml(e.agent)}</span>
        <span class="evt-kind">${escapeHtml(e.kind)}</span>
        <span class="evt-detail">${escapeHtml(e.detail)}${e.ticketId ? ` <em>· ticket ${e.ticketId.slice(0, 8)}</em>` : ""}</span>
        <span class="evt-when">${timeAgo(e.createdAt)}</span>
      </div>`;
      })
      .join("\n");

    res.status(200).type("html").send(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ClimbSmarter Agents</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f7f8fa; --panel: #ffffff; --text: #17191c; --muted: #697177;
    --line: #e4e7eb; --accent: #1f6feb; --accent-t: #ffffff; --shadow: 0 1px 3px rgba(0,0,0,.07), 0 8px 24px rgba(0,0,0,.05);
    --ok: #30a46c;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0d1017; --panel: #151922; --text: #e8eaed; --muted: #8b949e; --line: #262d38; --shadow: 0 1px 3px rgba(0,0,0,.5); }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.55 -apple-system, "Segoe UI", Roboto, sans-serif; }
  .top { position: sticky; top: 0; z-index: 5; backdrop-filter: blur(10px);
         background: color-mix(in srgb, var(--bg) 82%, transparent); border-bottom: 1px solid var(--line); }
  .top-inner { max-width: 1080px; margin: 0 auto; padding: 14px 20px; display: flex; align-items: center; gap: 14px; }
  .brand { font-weight: 700; font-size: 16px; }
  .brand b { color: var(--accent); }
  .navlink { font-size: 13px; text-decoration: none; color: var(--accent); border: 1px solid var(--line);
             padding: 5px 12px; border-radius: 999px; margin-left: auto; }
  .navlink:hover { border-color: var(--accent); }
  main { max-width: 1080px; margin: 0 auto; padding: 20px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 1.2px; color: var(--muted); margin: 22px 0 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 14px; }
  .agent-card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow); padding: 14px 16px; }
  .agent-card header { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .avatar { width: 38px; height: 38px; display: grid; place-items: center; font-size: 19px; border-radius: 50%;
            background: color-mix(in srgb, var(--agent) 15%, transparent); border: 1px solid color-mix(in srgb, var(--agent) 40%, transparent); }
  .who { display: flex; flex-direction: column; line-height: 1.25; }
  .who b { font-size: 14.5px; }
  .who span { font-size: 11.5px; color: var(--muted); }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); opacity: .4; margin-left: auto; }
  .dot.on { background: var(--ok); opacity: 1; box-shadow: 0 0 8px var(--ok); }
  dl { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; margin: 0; }
  dt { font-size: 10px; text-transform: uppercase; letter-spacing: .8px; color: var(--muted); }
  dd { margin: 1px 0 0; font-size: 13px; font-weight: 600; }
  dd.working { color: var(--ok); }
  dd.idle { color: var(--muted); font-weight: 400; }
  .feed { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow); padding: 6px 0; }
  .evt { display: flex; gap: 10px; align-items: baseline; padding: 9px 16px; border-bottom: 1px solid var(--line); font-size: 13px; flex-wrap: wrap; }
  .evt:last-child { border-bottom: 0; }
  .evt-agent { font-weight: 700; color: var(--agent); }
  .evt-kind { font-size: 10.5px; text-transform: uppercase; letter-spacing: .6px; color: var(--muted);
              border: 1px solid var(--line); border-radius: 5px; padding: 1px 6px; }
  .evt-detail { color: var(--text); }
  .evt-detail em { color: var(--muted); font-style: normal; }
  .evt-when { margin-left: auto; color: var(--muted); font-size: 11.5px; white-space: nowrap; }
  .empty { text-align: center; color: var(--muted); padding: 40px 0; }
  details.report { border-bottom: 1px solid var(--line); }
  details.report:last-child { border-bottom: 0; }
  details.report summary { display: flex; gap: 10px; align-items: baseline; padding: 10px 16px; cursor: pointer; font-size: 13px; }
  details.report pre { margin: 0; padding: 10px 16px 14px; white-space: pre-wrap; font-size: 12.5px; color: var(--text);
                       background: color-mix(in srgb, var(--bg) 60%, transparent); }
  .appr-count { display: inline-grid; place-items: center; min-width: 20px; height: 20px; padding: 0 6px;
                border-radius: 10px; background: #e5484d; color: #fff; font-size: 11.5px; margin-left: 6px; }
  .appr-act { margin-left: auto; font-size: 12.5px; color: var(--accent); text-decoration: none; white-space: nowrap; }
  .appr-bar { display: flex; align-items: center; gap: 10px; padding: 8px 16px 12px; font-size: 12px; color: var(--muted); }
  .appr-bar button { margin-left: auto; font: inherit; font-weight: 600; cursor: pointer; border-radius: 8px;
                     padding: 6px 12px; background: transparent; color: var(--text); border: 1px solid var(--line); }
  .appr-bar button:hover:not(:disabled) { border-color: var(--accent); }
  .appr-bar button:disabled { opacity: .5; cursor: default; }
</style>
</head>
<body>
<div class="top"><div class="top-inner">
  <span class="brand">Climb<b>Smarter</b> · Agents</span>
  <a class="navlink" href="/api/admin/support?admin_token=${tok}">📥 Support inbox</a>
</div></div>
<main>
  <h2>Needs your approval ${approvalCount ? `<span class="appr-count">${approvalCount}</span>` : ""}</h2>
  <div class="feed">
${
  approvalCount === 0
    ? `<div class="empty">Nothing waiting on you. The company is handling it. 🎉</div>`
    : [
        ...pendingTickets.map(
          (t) => `
      <div class="evt">
        <span class="evt-agent" style="--agent:${AGENT_COLORS[FLEET.support.name]}">${FLEET.support.name}</span>
        <span class="evt-kind">${t.status === "drafted" ? "reply to send" : "needs a draft"}</span>
        <span class="evt-detail">${escapeHtml(t.subject)}</span>
        <a class="appr-act" href="/api/admin/support?admin_token=${tok}">Review &amp; send →</a>
        <span class="evt-when">${timeAgo(t.createdAt)}</span>
      </div>`,
        ),
        ...pendingReports.map((r) => {
          const color = AGENT_COLORS[r.agent] ?? "#697177";
          const hint =
            r.agent === FLEET.coder.name
              ? "To apply: tell Claude “apply Daedalus's latest proposal”."
              : "Publish wherever you like, then mark reviewed.";
          return `
      <details class="report">
        <summary><span class="evt-agent" style="--agent:${color}">${escapeHtml(r.agent)}</span>
          <span class="evt-kind">${r.agent === FLEET.coder.name ? "code proposal" : "content draft"}</span>
          <b>${escapeHtml(r.title)}</b><span class="evt-when">${timeAgo(r.createdAt)}</span></summary>
        <pre>${escapeHtml(r.body).slice(0, 8000)}</pre>
        <div class="appr-bar"><span>${hint}</span>
          <button class="ghost" onclick="markReviewed('${r.id}', this)">Mark reviewed ✓</button></div>
      </details>`;
        }),
      ].join("\n")
}
  </div>
  <h2>Core fleet</h2>
  <div class="grid">
${agentCards}
  </div>
  <h2>Reports</h2>
  <div class="feed">
${
  reports.length
    ? reports
        .map((r) => {
          const color = AGENT_COLORS[r.agent] ?? "#697177";
          return `
      <details class="report">
        <summary><span class="evt-agent" style="--agent:${color}">${escapeHtml(r.agent)}</span>
          <b>${escapeHtml(r.title)}</b><span class="evt-when">${timeAgo(r.createdAt)}</span></summary>
        <pre>${escapeHtml(r.body).slice(0, 8000)}</pre>
      </details>`;
        })
        .join("\n")
    : `<div class="empty">No reports yet — Argus, Metis, Calliope, Atlas and Chief file them on their own schedules.</div>`
}
  </div>
  <h2>Live feed</h2>
  <div class="feed">
${feed || `<div class="empty">No agent activity yet — it starts the moment the first support email arrives.</div>`}
  </div>
</main>
<script>
  const ADMIN_TOKEN = ${JSON.stringify(adminToken)};
  async function markReviewed(id, btn) {
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const r = await fetch('/api/admin/reports/' + id + '/reviewed', {
        method: 'PATCH',
        headers: { 'x-admin-token': ADMIN_TOKEN },
      });
      if (r.ok) location.reload(); else { btn.disabled = false; btn.textContent = 'Mark reviewed ✓'; }
    } catch { btn.disabled = false; btn.textContent = 'Mark reviewed ✓'; }
  }
  setTimeout(() => location.reload(), 20000);
</script>
</body>
</html>`);
  } catch (err: unknown) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "admin.agents: failed to render page",
    );
    res.status(500).send("Internal error");
  }
});

// Mark a pending report (Daedalus proposal / Calliope draft) as handled by a
// human — removes it from the approvals queue. Review-state only; no other action.
router.patch("/api/admin/reports/:id/reviewed", adminAuth, async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await db.update(agentReportsTable).set({ status: "reviewed" }).where(eq(agentReportsTable.id, id));
    logger.info({ reportId: id }, "admin.reports: marked reviewed");
    res.status(200).json({ ok: true });
  } catch (err: unknown) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), reportId: id },
      "admin.reports: failed to mark reviewed",
    );
    res.status(500).json({ error: "Internal error" });
  }
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
    await logAgentEvent("George (human)", "sent", id, "approved draft and sent reply");
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
    await logAgentEvent("George (human)", "dismissed", id, "dismissed ticket");
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
