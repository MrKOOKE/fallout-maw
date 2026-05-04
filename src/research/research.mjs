import { TEMPLATES } from "../constants.mjs";
import { executeSkillCheck } from "../rolls/skill-check.mjs";
import { format, localize } from "../utils/i18n.mjs";
import { toInteger } from "../utils/numbers.mjs";
import {
  clampResearchProgress,
  formatResearchValue,
  getResearchById,
  roundResearchValue
} from "./storage.mjs";
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

export async function applyResearchTime(actor, researchId, duration = {}, { createMessages = true } = {}) {
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

  let totalGain = 0;

  for (let index = 0; index < checks; index += 1) {
    const outcome = await executeSkillCheck(actor, research.skillKey, {
      difficulty: research.difficulty
    }, {
      createMessage: createMessages
    });

    if (!outcome) throw new Error(localize("FALLOUTMAW.Messages.ResearchSkillMissing"));

    counts[outcome.result.key] = (counts[outcome.result.key] ?? 0) + 1;
    if (outcome.result.autoFailure) counts.autoFailure += 1;
    totalGain += calculateResearchProgressGain(outcome.skill.value, outcome.result);
  }

  totalGain = roundResearchValue(totalGain);
  const nextProgress = clampResearchProgress(Number(research.progress) + totalGain, research.target);
  await actor.updateResearch(researchId, { progress: nextProgress });

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
}

export async function finalizeResearch(actor, researchId) {
  const research = getResearchById(actor.system?.researches, researchId);
  if (!research || (Number(research.progress) < Number(research.target))) return null;

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

  await actor.deleteResearch(researchId);
  return {
    research,
    message
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
