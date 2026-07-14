import { db, agentEventsTable } from "@workspace/db";
import { logger } from "./logger";

// The agent fleet. Category -> persona. Hermes is the triage router; the
// five specialists each own one draft-producing category. Displayed on the
// /api/admin/agents dashboard and in ticket cards.
export const FLEET = {
  triage: { name: "Hermes", role: "Triage Router", icon: "🧭" },
  bug: { name: "Hephaestus", role: "Bug-Report Agent", icon: "🔨" },
  billing: { name: "Plutus", role: "Billing Agent", icon: "💳" },
  training_question: { name: "Atlas", role: "Training Agent", icon: "🧗" },
  account: { name: "Athena", role: "Account Agent", icon: "🔑" },
  other: { name: "Iris", role: "General Agent", icon: "💬" },
} as const;

export type AgentEventKind = "intake" | "classified" | "drafted" | "sent" | "dismissed" | "error";

/**
 * Record an agent action for the fleet dashboard. Fire-safe: any failure is
 * logged and swallowed — observability must never break the support pipeline.
 */
export async function logAgentEvent(
  agent: string,
  kind: AgentEventKind,
  ticketId: string | null,
  detail: string,
): Promise<void> {
  try {
    await db.insert(agentEventsTable).values({ agent, kind, ticketId, detail });
  } catch (err: unknown) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), agent, kind },
      "agentLog: failed to record event (ignored)",
    );
  }
}
