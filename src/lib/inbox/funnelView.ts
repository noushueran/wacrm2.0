import { UI_FUNNEL_STAGES } from "./funnel";

interface FunnelStateInput {
  attributed: boolean;
  lane: "code" | "ctwa" | null;
  currentStage: string | null;
  reachedAt: Record<string, number>;
  metaStatus: Record<string, string>;
}

export interface FunnelStep {
  key: string;
  internalOnly: boolean;
  needsValue: boolean;
  done: boolean;
  current: boolean;
  upcoming: boolean;
  reportsToMeta: boolean;
  reachedAt?: number;
  metaStatus?: string;
}

/** Composes the ordered stepper view. A stage is `done` if it has a
 *  transition (`reachedAt`), `current` if it equals `currentStage`, else
 *  `upcoming`. `reportsToMeta` = the conversation is attributed AND the stage
 *  isn't internal-only. */
export function buildFunnelSteps(state: FunnelStateInput): FunnelStep[] {
  const steps: FunnelStep[] = [];
  for (const s of UI_FUNNEL_STAGES) {
    const reachedAt = state.reachedAt[s.key];
    const current = state.currentStage === s.key;
    const done = reachedAt !== undefined && !current;
    // A terminal stage (lost) is an exit, not a milestone: hide it from
    // the stepper unless this conversation actually went there.
    if (s.terminal && !done && !current) continue;
    steps.push({
      key: s.key,
      internalOnly: s.internalOnly,
      needsValue: s.needsValue,
      done,
      current,
      upcoming: !done && !current,
      reportsToMeta: state.attributed && !s.internalOnly,
      reachedAt,
      metaStatus: state.metaStatus[s.key],
    });
  }
  return steps;
}
