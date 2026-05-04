import { TEMPLATES } from "../constants.mjs";
import { getSkillSettings } from "../settings/accessors.mjs";
import { toInteger } from "../utils/numbers.mjs";

const { DialogV2 } = foundry.applications.api;
const FormDataExtended = foundry.applications.ux.FormDataExtended;
const { renderTemplate } = foundry.applications.handlebars;

const DEFAULT_CHECK = Object.freeze({
  difficulty: 60,
  situationalModifier: 0,
  criticalSuccessBonus: 0,
  criticalFailureBonus: 0
});

export async function openSkillCheckDialog(actor, skillKey) {
  const skill = prepareSkill(actor, skillKey);
  if (!skill) return undefined;

  const content = await renderTemplate(TEMPLATES.skillCheckDialog, {
    actor,
    skill,
    defaults: DEFAULT_CHECK
  });

  const formData = await DialogV2.prompt({
    window: {
      title: game.i18n.format("FALLOUTMAW.SkillCheck.Title", { skill: skill.label })
    },
    content,
    position: { width: 460 },
    rejectClose: false,
    render: (_event, dialog) => activateSkillCheckDialog(dialog),
    ok: {
      label: "FALLOUTMAW.SkillCheck.RollButton",
      icon: "fa-solid fa-dice-d20",
      callback: (_event, button) => new FormDataExtended(button.form).object
    }
  });

  if (!formData) return undefined;
  return rollSkillCheck(actor, skill, normalizeDialogData(formData));
}

export async function rollSkillCheck(actor, skill, data = {}) {
  const check = createMutableCheck(actor, skill, data);
  Hooks.callAll("fallout-maw.modifySkillCheck", check);

  const edge = calculateEdge(check.advantageCount, check.disadvantageCount);
  const rolls = await rollD100(edge.rollMode === "normal" ? 1 : 2);
  const selectedRoll = selectRoll(rolls, edge.rollMode);
  const finalSkillValue = toInteger(check.skill.value) + toInteger(check.situationalModifier) + edge.skillModifier;
  const total = finalSkillValue + selectedRoll.total;
  const critical = calculateCriticalThresholds(check);
  const result = determineResult(selectedRoll.total, total, check.difficulty, critical);

  const cardContext = {
    actor,
    skill: check.skill,
    difficulty: toInteger(check.difficulty),
    situationalModifier: toInteger(check.situationalModifier),
    finalSkillValue,
    total,
    rollSummary: rolls.map(roll => roll.total).join(" / "),
    edge: {
      ...edge,
      label: formatEdge(edge)
    },
    critical: {
      ...critical,
      failureLabel: critical.failureMaximum > 0 ? `<= ${critical.failureMaximum}` : game.i18n.localize("FALLOUTMAW.SkillCheck.None"),
      successLabel: critical.successMinimum <= 100 ? `>= ${critical.successMinimum}` : game.i18n.localize("FALLOUTMAW.SkillCheck.None")
    },
    result
  };

  const content = await renderTemplate(TEMPLATES.skillCheckChatCard, cardContext);
  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content,
    sound: CONFIG.sounds.dice,
    rolls: rolls.map(roll => roll.toJSON()),
    flags: {
      "fallout-maw": {
        skillCheck: {
          skillKey: check.skill.key,
          difficulty: check.difficulty,
          total,
          result: result.key
        }
      }
    }
  });
}

function prepareSkill(actor, skillKey) {
  const setting = getSkillSettings().find(skill => skill.key === skillKey);
  const actorSkill = actor.system?.skills?.[skillKey];
  if (!setting || !actorSkill) return null;
  return {
    key: setting.key,
    abbr: setting.abbr,
    label: setting.label,
    value: toInteger(actorSkill.value)
  };
}

function normalizeDialogData(data) {
  const advantage = Boolean(data.advantage);
  const disadvantage = Boolean(data.disadvantage);
  return {
    difficulty: toInteger(data.difficulty),
    situationalModifier: toInteger(data.situationalModifier),
    criticalSuccessBonus: toInteger(data.criticalSuccessBonus),
    criticalFailureBonus: toInteger(data.criticalFailureBonus),
    advantageCount: advantage ? Math.max(1, toInteger(data.advantageCount)) : 0,
    disadvantageCount: disadvantage ? Math.max(1, toInteger(data.disadvantageCount)) : 0
  };
}

function createMutableCheck(actor, skill, data) {
  return {
    actor,
    skill: { ...skill },
    difficulty: toInteger(data.difficulty ?? DEFAULT_CHECK.difficulty),
    situationalModifier: toInteger(data.situationalModifier ?? DEFAULT_CHECK.situationalModifier),
    criticalSuccessBonus: toInteger(data.criticalSuccessBonus ?? DEFAULT_CHECK.criticalSuccessBonus),
    criticalFailureBonus: toInteger(data.criticalFailureBonus ?? DEFAULT_CHECK.criticalFailureBonus),
    advantageCount: Math.max(0, toInteger(data.advantageCount)),
    disadvantageCount: Math.max(0, toInteger(data.disadvantageCount)),
    modifiers: []
  };
}

async function rollD100(count) {
  const rolls = [];
  for (let index = 0; index < count; index += 1) {
    const roll = new Roll("1d100");
    rolls.push(await roll.evaluate());
  }
  return rolls;
}

function calculateEdge(advantageCount, disadvantageCount) {
  const net = toInteger(advantageCount) - toInteger(disadvantageCount);
  if (net > 0) {
    const extra = Math.max(0, net - 1);
    return {
      net,
      rollMode: "advantage",
      skillModifier: extra * 30,
      extra
    };
  }
  if (net < 0) {
    const extra = Math.max(0, Math.abs(net) - 1);
    return {
      net,
      rollMode: "disadvantage",
      skillModifier: extra * -30,
      extra
    };
  }
  return {
    net: 0,
    rollMode: "normal",
    skillModifier: 0,
    extra: 0
  };
}

function selectRoll(rolls, rollMode) {
  if (rollMode === "advantage") return rolls.reduce((best, roll) => roll.total > best.total ? roll : best, rolls[0]);
  if (rollMode === "disadvantage") return rolls.reduce((worst, roll) => roll.total < worst.total ? roll : worst, rolls[0]);
  return rolls[0];
}

function calculateCriticalThresholds(check) {
  const gambling = toInteger(check.actor.system?.skills?.gambling?.value);
  const failureChance = clamp(toInteger(check.criticalFailureBonus) + 5, 0, 100);
  const successChance = clamp(Number(check.criticalSuccessBonus || 0) + 4 + (gambling / 20), 0, 100);
  return {
    failureChance,
    successChance,
    failureMaximum: Math.floor(failureChance),
    successMinimum: successChance > 0 ? Math.ceil(101 - successChance) : 101
  };
}

function determineResult(roll, total, difficulty, critical) {
  if (critical.failureMaximum > 0 && roll <= critical.failureMaximum) {
    return {
      key: "criticalFailure",
      label: game.i18n.localize("FALLOUTMAW.SkillCheck.CriticalFailure"),
      cssClass: "critical-failure"
    };
  }
  if (critical.successMinimum <= 100 && roll >= critical.successMinimum) {
    return {
      key: "criticalSuccess",
      label: game.i18n.localize("FALLOUTMAW.SkillCheck.CriticalSuccess"),
      cssClass: "critical-success"
    };
  }
  if (total >= toInteger(difficulty)) {
    return {
      key: "success",
      label: game.i18n.localize("FALLOUTMAW.SkillCheck.Success"),
      cssClass: "success"
    };
  }
  return {
    key: "failure",
    label: game.i18n.localize("FALLOUTMAW.SkillCheck.Failure"),
    cssClass: "failure"
  };
}

function activateSkillCheckDialog(dialog) {
  const form = dialog.element?.querySelector("form") ?? dialog.form;
  if (!form) return;
  const advantage = form.querySelector("[data-skill-check-advantage]");
  const disadvantage = form.querySelector("[data-skill-check-disadvantage]");
  const advantageCount = form.elements.advantageCount;
  const disadvantageCount = form.elements.disadvantageCount;
  const syncCounters = () => {
    if (advantageCount) advantageCount.disabled = !advantage?.checked;
    if (disadvantageCount) disadvantageCount.disabled = !disadvantage?.checked;
  };
  advantage?.addEventListener("change", () => {
    if (advantage.checked && disadvantage) disadvantage.checked = false;
    syncCounters();
  });
  disadvantage?.addEventListener("change", () => {
    if (disadvantage.checked && advantage) advantage.checked = false;
    syncCounters();
  });
  syncCounters();
}

function formatEdge(edge) {
  if (edge.rollMode === "advantage") return game.i18n.format("FALLOUTMAW.SkillCheck.AdvantageSummary", {
    count: edge.net,
    bonus: edge.skillModifier
  });
  if (edge.rollMode === "disadvantage") return game.i18n.format("FALLOUTMAW.SkillCheck.DisadvantageSummary", {
    count: Math.abs(edge.net),
    bonus: edge.skillModifier
  });
  return game.i18n.localize("FALLOUTMAW.SkillCheck.Normal");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}
