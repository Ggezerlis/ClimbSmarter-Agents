# ClimbSmarter Support — Agent Architecture

Five AI agents behind one human. No agent can send email; the only send call in
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
 │  1. BUG-REPORT AGENT      – repro info, no ETAs│
 │  2. BILLING AGENT         – never resolves;    │
 │     "George reviews within 24h" only           │
 │  3. TRAINING AGENT        – climbing answers,  │
 │     no medical advice                          │
 │  4. ACCOUNT AGENT         – self-service steps,│
 │     never touches passwords                    │
 │  5. GENERAL AGENT (other) – warm catch-all     │
 └──────────────────┬────────────────────────────┘
                    ▼
        ticket saved with draft (status: drafted)
                    │
                    ▼
        HUMAN REVIEW at /admin/support (ADMIN_SECRET-gated)
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
