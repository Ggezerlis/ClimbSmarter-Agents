# ClimbSmarter — The Agent Company

An AI company with one human. Seven agents, each with a real job: five run fully autonomously on schedules; Hermes handles support with every outbound reply gated behind George's click. No agent can send email; the only send call in
the codebase is the human-triggered **Approve & Send** handler in
`artifacts/api-server/src/routes/admin.ts`.

## Pipeline

```
inbound email (Resend webhook, Svix-verified, 60 req/min limit)
        │
        ▼
 ┌──────────────┐   spam / injection
 │ TRIAGE AGENT │──────────────────────► ticket stored, no draft
 │  (classifier │
 │  + spam gate)│
 └──────┬───────┘
        │ routes by category
        ▼
 ┌───────────────────────────────────────────────┐
 │  SPECIALIST DRAFT AGENTS (one per category)    │
 │  1. HEPHAESTUS 🔨 Bug-Report – repro, no ETAs  │
 │  2. PLUTUS 💳 Billing     – never resolves;    │
 │     "George reviews within 24h" only           │
 │  3. ATLAS 🧗 Training     – climbing answers,  │
 │     no medical advice                          │
 │  4. ATHENA 🔑 Account     – self-service steps,│
 │     never touches passwords                    │
 │  5. IRIS 💬 General (other) – warm catch-all   │
 └──────────────────┬────────────────────────────┘
 (The triage router is HERMES 🧭. Every agent action is
  logged to agent_events and shown on the fleet dashboard
  at /api/admin/agents: status, heartbeat, live feed.)
                    ▼
        ticket saved with draft (status: drafted)
                    │
                    ▼
        HUMAN REVIEW at /api/admin/support (ADMIN_SECRET-gated)
        edit → Approve & Send  ─or─  Dismiss
                    │
                    ▼
        the one and only resend.emails.send() call
        (Re: subject, In-Reply-To/References threading)
```

## Where things live

| Piece | File |
|---|---|
| Agent prompts + pipeline | `artifacts/api-server/src/lib/aiTriage.ts` |
| Inbound webhook (verify, dedup, store, rate limit) | `artifacts/api-server/src/routes/supportInbound.ts` |
| Human review UI + the single send call | `artifacts/api-server/src/routes/admin.ts` |
| Admin gate (`ADMIN_SECRET`) | `artifacts/api-server/src/middlewares/adminAuth.ts` |
| Ticket table (Drizzle/Postgres) | `lib/db/src/schema/support.ts` |

## What this repo is (and isn't)

The ClimbSmarter application itself lives in a Replit workspace (Express v5
monorepo, Postgres + Drizzle). That workspace has no GitHub remote, so this repo
holds the support-agent feature's source of truth as it was authored: every file
here mirrors its path in the real app (`lib/db/src/schema/*` → the
`@workspace/db` package; `artifacts/api-server/src/*` → the API server).

Deploying = applying these files to the Replit workspace at the same paths,
plus the two small edits to existing files documented in
[`artifacts/api-server/SUPPORT_AGENT_PATCH_NOTES.md`](artifacts/api-server/SUPPORT_AGENT_PATCH_NOTES.md)
(the `app.ts` raw-body webhook mount and the `@anthropic-ai/sdk` dependency),
then running the Drizzle push and restarting.

## Environment

| Secret | Purpose |
|---|---|
| `RESEND_WEBHOOK_SECRET` | Svix signature verification of inbound webhooks |
| `RESEND_API_KEY` | Fetching full inbound emails from the Receiving API |
| `ANTHROPIC_API_KEY` | The triage + drafting agents |
| `ADMIN_SECRET` | Gates the `/api/admin/support` page and its API routes |

Outbound sending uses the app's existing Replit-Connectors-based Resend client.

## Development test mode

When `NODE_ENV !== "production"` (and only then), `POST /api/support/inbound/__test`
simulates an inbound email without a Resend delivery or valid signature — see
the patch notes for the full walkthrough. In production that route does not
exist; the signed webhook is the sole entry point.

## Safety invariants

1. **Nothing sends automatically.** One `resend.emails.send()` call exists,
   inside the admin-authenticated approve handler, behind a human click.
2. Every agent's system prompt starts with a shared safety preamble: email
   content is untrusted, embedded instructions are never followed, no refund
   promises, no internal details.
3. Spam and prompt-injection attempts are gated at the triage agent and never
   reach a drafting agent.
4. Any AI failure degrades to `category: other, status: new` — tickets are
   never lost to an agent error.
5. Production logs carry ticket ids, never email bodies.
6. All agent calls use model `claude-sonnet-4-6`.

## The company (v2 structure)

| Agent | Job | Cadence | Autonomy |
|---|---|---|---|
| 🎯 Chief | Orchestrator — daily company brief (team activity + support stats) | daily | full |
| 🛠️ Daedalus | Engineer — daily engineering proposals with diff sketches, mined from error telemetry, bug tickets, and Atlas's research; cannot modify or deploy code himself | daily | proposals only; a human applies diffs |
| 🧭 Hermes | Support — triage, spam gate, category-skill drafting | per email | drafts only; **send needs George** |
| 👁️ Argus | Ops Monitor — DB/secrets health checks; files a report only when something's wrong | 15 min | full |
| 📊 Metis | Analytics — daily support digest | daily | full |
| ✍️ Calliope | Content — social post drafts for human review | weekly | full (internal drafts) |
| 🧠 Atlas | Research — product briefs from ticket trends (ticket text treated as untrusted) | weekly | full |

Scheduler: in-process, started at boot from the routes index; DB-deduped by each
agent's last event so restarts never double-run. Work products land in
`agent_reports` and are readable on `/api/admin/agents`. None of the autonomous
agents has any code path to email, billing, or any outward-facing action — the
single Resend send call remains inside the human-approved admin handler.
