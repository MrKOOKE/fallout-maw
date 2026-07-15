import { TEMPLATES } from "../constants.mjs";
import { completeAbilityResearch } from "../abilities/purchase.mjs";
import { withSystemEventRoot } from "../events/dispatcher.mjs";
import { requestSkillCheckBatch } from "../rolls/skill-check.mjs";
import { format, localize } from "../utils/i18n.mjs";
import { toInteger } from "../utils/numbers.mjs";
import {
  clampResearchProgress,
  formatResearchValue,
  getResearchById,
  roundResearchValue
} from "./storage.mjs";
import { resolveResearchChainRef } from "./events.mjs";
const { renderTemplate } = foundry.applications.handlebars;

export function getResearchCheckCount(duration = {}) {
  const hours = Math.max(0, toInteger(duration.hours));
  const halfHour = Boolean(duration.halfHour);
  return (hours * 2) + (halfHour ? 1 : 0);
}

export function calculateResearchProgressGain(skillValue, result = {}) {
  const baseSkill = Math.max(0, Number(skillValue) || 0);
  if (!baseSkill) return 0;

  if (result.key === "criticalSuccess") return roundResearchValue(baseSkill * 1.5);
  if (result.key === "success") return roundResearchValue(baseSkill);
  if (result.key === "failure") return result.autoFailure ? 0 : roundResearchValue(baseSkill * 0.3);
  return 0;
}

export async function applyResearchTime(actor, researchId, duration = {}, options = {}) {
  const { createMessages = true } = options;
  const research = getResearchById(actor.system?.researches, researchId);
  if (!research) return null;

  const checks = getResearchCheckCount(duration);
  const counts = createResearchResultCounters();
  if (checks < 1) {
    return {
      research,
      checks,
      counts,
      totalGain: 0,
      gainLabel: "0",
      progressLabel: formatResearchValue(research.progress),
      targetLabel: formatResearchValue(research.target)
    };
  }

  const occurrenceId = String(options?.occurrenceId ?? "").trim() || foundry.utils.randomID();
  return withSystemEventRoot({
    kind: "research.progress",
    operationId: String(options?.operationId ?? "").trim()
      || `research-progress:${actor.uuid}:${research.id}:${occurrenceId}`,
    sceneUuid: String(actor.token?.parent?.uuid ?? actor.token?.scene?.uuid ?? canvas?.scene?.uuid ?? ""),
    combatUuid: String(game.combat?.uuid ?? ""),
    chainRef: resolveResearchChainRef(options)
  }, async scope => {
    let totalGain = 0;
    const batch = await requestSkillCheckBatch({
      actor,
      skillKey: research.skillKey,
      requester: "research",
      title: research.name,
      animate: false,
      createMessage: createMessages,
      chainRef: scope.chainRef,
      options: {
        operationId: `research-checks:${actor.uuid}:${research.id}:${occurrenceId}`,
        occurrenceId: `research:${research.id}:${occurrenceId}`
      },
      source: {
        kind: "researchProgress",
        researchId: research.id,
        chainRef: scope.chainRef
      },
      entries: Array.from({ length: checks }, () => ({
        data: {
          difficulty: research.difficulty
        }
      }))
    });
    if (!batch) throw new Error(localize("FALLOUTMAW.Messages.ResearchSkillMissing"));

    for (const outcome of batch.outcomes) {
      counts[outcome.result.key] = (counts[outcome.result.key] ?? 0) + 1;
      if (outcome.result.autoFailure) counts.autoFailure += 1;
      totalGain += calculateResearchProgressGain(outcome.skill.value, outcome.result);
    }

    totalGain = roundResearchValue(totalGain);
    const nextProgress = clampResearchProgress(Number(research.progress) + totalGain, research.target);
    await actor.updateResearch(researchId, { progress: nextProgress }, {
      chainRef: scope.chainRef,
      occurrenceId,
      operationId: `research-progress-commit:${actor.uuid}:${research.id}:${occurrenceId}`,
      progressSource: String(options?.progressSource ?? "researchTime"),
      gain: totalGain,
      checkSummary: {
        checks,
        resolved: batch.outcomes.length,
        counts,
        totalGain
      }
    });

    return {
      research: {
        ...research,
        progress: nextProgress,
        completed: nextProgress >= research.target
      },
      checks,
      counts,
      totalGain,
      gainLabel: formatResearchValue(totalGain),
      progressLabel: formatResearchValue(nextProgress),
      targetLabel: formatResearchValue(research.target)
    };
  });
}

export async function finalizeResearch(actor, researchId, options = {}) {
  const research = getResearchById(actor.system?.researches, researchId);
  if (!research || (Number(research.progress) < Number(research.target))) return null;
  if (research.type === "ability") return finalizeAbilityResearch(actor, researchId, research, options);

  const content = await renderTemplate(TEMPLATES.researchCompleteChatCard, {
    actor,
    research: {
      ...research,
      progressLabel: formatResearchValue(research.progress),
      targetLabel: formatResearchValue(research.target)
    },
    completionMessage: format("FALLOUTMAW.Research.CompletedChatMessage", {
      actor: actor.name,
      name: research.name
    })
  });

  const message = await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content,
    flags: {
      "fallout-maw": {
        research: {
          id: research.id,
          name: research.name,
          completed: true
        }
      }
    }
  });

  await actor.deleteResearch(researchId, {
    ...options,
    event: "completed",
    progressSource: String(options?.progressSource ?? "researchFinalization"),
    reason: String(options?.reason ?? "completed")
  });
  return {
    research,
    message
  };
}

async function finalizeAbilityResearch(actor, researchId, research, options = {}) {
  const result = await completeAbilityResearch(actor, researchId, {
    ...options,
    progressSource: String(options?.progressSource ?? "researchFinalization")
  });
  if (!result) return null;
  if (result.blocked) return null;

  const content = await renderTemplate(TEMPLATES.researchCompleteChatCard, {
    actor,
    research: {
      ...research,
      progressLabel: formatResearchValue(research.progress),
      targetLabel: formatResearchValue(research.target)
    },
    completionMessage: format("FALLOUTMAW.Research.CompletedChatMessage", {
      actor: actor.name,
      name: research.name
    })
  });

  const message = await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content,
    flags: {
      "fallout-maw": {
        research: {
          id: research.id,
          name: research.name,
          completed: true,
          type: "ability",
          sourceId: research.sourceId
        }
      }
    }
  });

  return {
    research,
    message,
    item: result.item
  };
}

function createResearchResultCounters() {
  return {
    criticalSuccess: 0,
    success: 0,
    failure: 0,
    criticalFailure: 0,
    autoFailure: 0
  };
}
