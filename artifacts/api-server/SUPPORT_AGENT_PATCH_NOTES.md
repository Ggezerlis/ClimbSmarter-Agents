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
