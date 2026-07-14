import { db, agentEventsTable } from "@workspace/db";
import { logger } from "./logger";

// The company fleet. Each agent has one job. Hermes owns the entire support
// pipeline (his category-specialist prompts are his internal skill set); the
// others run autonomously on schedules via companyAgents.ts. Displayed on the
// /api/admin/agents dashboard.
export const FLEET = {
  chief: { name: "Chief", role: "Orchestrator", icon: "🎯" },
  support: { name: "Hermes", role: "Support Agent", icon: "🧭" },
  ops: { name: "Argus", role: "Ops Monitor", icon: "👁️" },
  analytics: { name: "Metis", role: "Analytics", icon: "📊" },
  content: { name: "Calliope", role: "Content", icon: "✍️" },
  research: { name: "Atlas", role: "Research", icon: "🧠" },
  coder: { name: "Daedalus", role: "Engineer", icon: "🛠️" },
} as const;

export type AgentEventKind =
  | "intake"
  | "classified"
  | "drafted"
  | "sent"
  | "dismissed"
  | "error"
  | "heartbeat"
  | "report"
  | "thought";

/**
 * Record an agent action for the fleet dashboard. Fire-safe: any failure is
 * logged and swallowed — observability must never break the pipelines.
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

/**
 * An agent's inner monologue — a short line about what it's doing or why.
 * For LLM agents this carries real model reasoning (e.g. Hermes'
 * classification rationale); for deterministic agents it narrates the run.
 * Shown as 💭 bubbles on the fleet cards and in the Thoughts panel.
 * Must never contain email body text — subjects/derived signals only.
 */
export async function logAgentThought(
  agent: string,
  ticketId: string | null,
  thought: string,
): Promise<void> {
  await logAgentEvent(agent, "thought", ticketId, thought.slice(0, 300));
}
