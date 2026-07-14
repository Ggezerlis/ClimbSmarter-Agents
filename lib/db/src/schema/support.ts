import { pgTable, text, uuid, timestamp, jsonb } from "drizzle-orm/pg-core";

// Support tickets created from inbound emails via the Resend Receiving API.
// One ticket per inbound email, deduped on resend_email_id.
export const supportTicketsTable = pgTable("support_tickets", {
  id: uuid("id").primaryKey().defaultRandom(),
  // The Resend email id from the inbound webhook — used for deduplication.
  resendEmailId: text("resend_email_id").notNull().unique(),
  senderAddress: text("sender_address").notNull(),
  subject: text("subject").notNull(),
  bodyText: text("body_text").notNull().default(""),
  // The Message-ID header from the original email — used for In-Reply-To threading.
  messageId: text("message_id"),
  // Attachment filenames only — no binary attachment data is downloaded or stored.
  attachmentFilenames: jsonb("attachment_filenames").$type<string[]>().default([]),
  // AI-assigned category: bug | billing | training_question | account | spam | other
  category: text("category").notNull().default("other"),
  // AI-generated draft reply, editable in the admin UI before sending.
  draftReply: text("draft_reply").notNull().default(""),
  // new: just received; drafted: AI has written a draft; sent: reply sent; dismissed: ignored.
  status: text("status").notNull().default("new"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Populated when status becomes "sent".
  sentAt: timestamp("sent_at", { withTimezone: true }),
});

// Activity log for the agent fleet: one row per agent action (intake,
// classification, draft, human send/dismiss). Powers the /api/admin/agents
// dashboard (status, heartbeat, live feed). Purely observational — writing
// to this table must never block or fail the support pipeline.
export const agentEventsTable = pgTable("agent_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Agent name, e.g. "Hermes", "Hephaestus", or "George (human)".
  agent: text("agent").notNull(),
  // intake | classified | drafted | sent | dismissed | error
  kind: text("kind").notNull(),
  ticketId: uuid("ticket_id"),
  detail: text("detail").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
