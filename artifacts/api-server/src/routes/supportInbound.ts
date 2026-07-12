import { Router, type IRouter, type Request, type Response } from "express";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { db, supportTicketsTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { triageEmail } from "../lib/aiTriage";

const router: IRouter = Router();

const RESEND_RECEIVING_API = "https://api.resend.com/emails";

interface ResendInboundEvent {
  type: string;
  data?: { email_id?: string };
}

interface ResendFullEmail {
  from?: string;
  subject?: string;
  text?: string;
  message_id?: string;
  attachments?: { filename?: string }[];
}

// Hand-rolled Svix signature verification (no svix/resend verify helper is used
// elsewhere in this codebase, so this mirrors that same approach): the secret is
// "whsec_" + base64(key); the signed content is "{id}.{timestamp}.{raw body}",
// HMAC-SHA256'd with the decoded key and compared against each "v1,<sig>" entry
// in the svix-signature header.
function verifySvixSignature(
  secret: string,
  svixId: string,
  svixTimestamp: string,
  svixSignature: string,
  rawBody: Buffer,
): boolean {
  try {
    const secretBytes = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
    const signedContent = `${svixId}.${svixTimestamp}.${rawBody.toString("utf8")}`;
    const expected = crypto.createHmac("sha256", secretBytes).update(signedContent).digest("base64");

    const candidates = svixSignature
      .split(" ")
      .map((entry) => entry.split(",")[1])
      .filter((sig): sig is string => Boolean(sig));

    return candidates.some((sig) => {
      const a = Buffer.from(sig);
      const b = Buffer.from(expected);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    });
  } catch {
    return false;
  }
}

async function processTicket(ticketId: string, emailId: string): Promise<void> {
  try {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      logger.error({ ticketId }, "supportInbound: RESEND_API_KEY not set, cannot fetch email");
      return;
    }

    const emailRes = await fetch(`${RESEND_RECEIVING_API}/${emailId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!emailRes.ok) {
      logger.error({ ticketId, status: emailRes.status }, "supportInbound: failed to fetch full email");
      return;
    }

    const full = (await emailRes.json()) as ResendFullEmail;

    const result = await triageEmail(ticketId, full.from ?? "", full.subject ?? "", full.text ?? "");

    await db
      .update(supportTicketsTable)
      .set({
        category: result.category,
        draftReply: result.draftReply,
        status: result.draftReply ? "drafted" : "new",
      })
      .where(eq(supportTicketsTable.id, ticketId));

    logger.info({ ticketId, category: result.category }, "supportInbound: triage complete");
  } catch (err: unknown) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), ticketId },
      "supportInbound: background triage failed — ticket kept as-is",
    );
  }
}

router.post("/", async (req: Request, res: Response) => {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    logger.error("supportInbound: RESEND_WEBHOOK_SECRET not set");
    res.status(503).send();
    return;
  }

  const svixId = req.header("svix-id");
  const svixTimestamp = req.header("svix-timestamp");
  const svixSignature = req.header("svix-signature");
  const rawBody = req.body;

  if (!svixId || !svixTimestamp || !svixSignature || !Buffer.isBuffer(rawBody)) {
    res.status(401).send();
    return;
  }

  if (!verifySvixSignature(secret, svixId, svixTimestamp, svixSignature, rawBody)) {
    logger.error("supportInbound: invalid Svix signature");
    res.status(401).send();
    return;
  }

  let event: ResendInboundEvent;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    res.status(400).send();
    return;
  }

  if (event.type !== "email.received") {
    res.status(200).send();
    return;
  }

  const emailId = event.data?.email_id;
  if (!emailId) {
    res.status(200).send();
    return;
  }

  // Respond fast; everything below runs after the response is already sent.
  res.status(200).send();

  try {
    const existing = await db
      .select({ id: supportTicketsTable.id })
      .from(supportTicketsTable)
      .where(eq(supportTicketsTable.resendEmailId, emailId))
      .limit(1);

    if (existing.length > 0) {
      logger.info({ emailId }, "supportInbound: duplicate email id, skipping");
      return;
    }

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      logger.error({ emailId }, "supportInbound: RESEND_API_KEY not set, cannot fetch email");
      return;
    }

    const emailRes = await fetch(`${RESEND_RECEIVING_API}/${emailId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!emailRes.ok) {
      logger.error({ emailId, status: emailRes.status }, "supportInbound: failed to fetch full email");
      return;
    }

    const full = (await emailRes.json()) as ResendFullEmail;

    const [ticket] = await db
      .insert(supportTicketsTable)
      .values({
        resendEmailId: emailId,
        senderAddress: full.from ?? "",
        subject: full.subject ?? "(no subject)",
        bodyText: full.text ?? "",
        messageId: full.message_id ?? null,
        attachmentFilenames: (full.attachments ?? [])
          .map((a) => a.filename)
          .filter((f): f is string => Boolean(f)),
        status: "new",
      })
      .onConflictDoNothing({ target: supportTicketsTable.resendEmailId })
      .returning({ id: supportTicketsTable.id });

    if (!ticket) {
      logger.info({ emailId }, "supportInbound: insert conflicted with an existing ticket, skipping");
      return;
    }

    logger.info({ ticketId: ticket.id, emailId }, "supportInbound: ticket created");
    await processTicket(ticket.id, emailId);
  } catch (err: unknown) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), emailId },
      "supportInbound: failed to store ticket",
    );
  }
});

export default router;
