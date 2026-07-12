# Manual wiring needed (2 small edits to existing files)

Everything else in this feature is a new, self-contained file (see the file list in
the PR/commit description). These two existing files were **not** reconstructed here
because only a fragment of each was confirmed, and fabricating the rest of an
existing file risks corrupting unrelated code — apply these exact edits by hand
in the real app instead.

## 1. `src/app.ts`

Add this immediately after the existing Stripe webhook registration, and before
the global `express.json()` call (same raw-body-before-json pattern already used
for Stripe):

```ts
// Register support inbound webhook BEFORE express.json() — needs raw Buffer for Svix verification
app.use(
  "/api/support/inbound",
  express.raw({ type: "*/*" }),
  supportInboundRouter,
);
```

(An import for `supportInboundRouter` should already exist near the top of the file.)

## 2. `package.json`

Add, if not already present:

```json
"@anthropic-ai/sdk": "^0.x"
```

`resend` should already be a dependency (it's used by `routes/auth.ts` and
`stripeEventHandlers.ts`) — no change needed there.

## 3. Database

Run the Drizzle push so the new `support_tickets` table actually exists:

```
pnpm --filter @workspace/db run push
```

## 4. Secrets to confirm/set in the real environment

- `ADMIN_SECRET` — already generated and set in the live Replit app's Secrets pane (value not recorded here — check Replit directly; it was also given to the user in chat, not committed to git)
- `RESEND_WEBHOOK_SECRET` — confirm present (Svix verification returns 503 without it)
- `ANTHROPIC_API_KEY` — confirm present (triage silently no-ops without it)
- `RESEND_API_KEY` — confirm present (used to fetch the full inbound email from the Resend Receiving API; sending itself goes through the existing Replit Connectors-based Resend client, not this key)

## 5. Webhook URL to register in Resend

```
https://climbsmarter.app/api/support/inbound
```

Register it under Resend → Webhooks → endpoint for the `email.received` event.
Do this only after steps 1–4 above are applied and the server restarted.

## 6. Testing the full flow (development only)

A test route exists **only when `NODE_ENV !== "production"`** — in production it
is never registered, so the Svix-verified webhook is the sole entry point.

```bash
# 1. Simulate an inbound email (creates a ticket + runs AI triage):
curl -X POST http://localhost:3000/api/support/inbound/__test \
  -H "Content-Type: application/json" \
  -d '{"from":"climber@example.com","subject":"Cannot log my session","text":"The app crashes when I save a bouldering session on my phone."}'

# 2. Open the admin page and see the ticket + draft:
#    http://localhost:3000/admin/support?admin_token=<ADMIN_SECRET>

# 3. Edit the draft if you like, click "Approve & Send" — that click is the only
#    thing in the entire system that calls Resend's send API (with Re: subject and
#    In-Reply-To/References headers when a Message-ID was captured).

# 4. Ticket status flips to "sent" with sent_at recorded. "Dismiss" marks it dismissed.
```

For production verification, use a real test email to your Resend inbound address
instead — there is no signature bypass outside development.
