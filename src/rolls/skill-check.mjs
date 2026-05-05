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

export async function requestSkillCheck({
  actor,
  skillKey = "",
  data = {},
  animate = true,
  createMessage = true,
  prompt = false,
  requester = ""
} = {}) {
  const resolvedSkill = resolveSkill(actor, skillKey);
  if (!resolvedSkill) return undefined;

  const requestData = prompt ? await promptSkillCheckData(actor, resolvedSkill) : data;
  if (!requestData) return undefined;

  const outcome = await performSkillCheck(actor, resolvedSkill, normalizeRequestData(requestData));
  if (animate) await playSkillCheckAnimation(outcome);
  if (!createMessage) return outcome;

  const message = await publishSkillCheckMessage(outcome, { requester });
  return {
    ...outcome,
    message
  };
}

async function promptSkillCheckData(actor, skill) {
  const content = await renderTemplate(TEMPLATES.skillCheckDialog, {
    actor,
    skill,
    defaults: DEFAULT_CHECK
  });

  return DialogV2.prompt({
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
}

async function performSkillCheck(actor, skill, data = {}) {
  if (!skill) return undefined;

  const check = createMutableCheck(actor, skill, data);
  Hooks.callAll("fallout-maw.modifySkillCheck", check);

  const edge = calculateEdge(check.advantageCount, check.disadvantageCount);
  const rolls = await rollD100(edge.rollMode === "normal" ? 1 : 2);
  const selectedRoll = selectRoll(rolls, edge.rollMode);
  const finalSkillValue = toInteger(check.skill.value) + toInteger(check.situationalModifier) + edge.skillModifier;
  const total = finalSkillValue + selectedRoll.total;
  const critical = calculateCriticalThresholds(check);
  const autoFailure = isAutomaticFailure(finalSkillValue, check.difficulty);
  const result = determineResult(
    selectedRoll.total,
    total,
    check.difficulty,
    critical,
    autoFailure
  );

  return {
    actor,
    check,
    skill: check.skill,
    rolls,
    selectedRoll,
    edge,
    finalSkillValue,
    total,
    critical,
    autoFailure,
    result
  };
}

async function publishSkillCheckMessage(outcome, { requester = "" } = {}) {
  const { actor, check, rolls, result, total } = outcome;
  const cardContext = buildSkillCheckViewContext(outcome);

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
          requester,
          total,
          result: result.key,
          autoFailure: result.autoFailure
        }
      }
    }
  });
}

function buildSkillCheckViewContext(outcome) {
  const { actor, check, skill, rolls, selectedRoll, edge, finalSkillValue, total, critical, autoFailure, result } = outcome;
  return {
    actor,
    skill,
    difficulty: toInteger(check.difficulty),
    situationalModifier: toInteger(check.situationalModifier),
    finalSkillValue,
    total,
    rollEntries: buildRollEntries(rolls, selectedRoll, check.difficulty, critical, finalSkillValue),
    thresholdRows: buildThresholdRows(check.difficulty, critical, finalSkillValue),
    scaleSegments: buildScaleSegments(check.difficulty, critical, finalSkillValue, selectedRoll.total),
    progressCells: buildProgressCells(check.difficulty, critical, finalSkillValue),
    autoFailure,
    progressTarget: autoFailure ? 100 : clamp(selectedRoll.total, 1, 100),
    edge: {
      ...edge,
      modeLabel: formatEdgeMode(edge),
      hasMultipleRolls: rolls.length > 1
    },
    result
  };
}

async function playSkillCheckAnimation(outcome) {
  const context = buildSkillCheckViewContext(outcome);
  const content = await renderTemplate(TEMPLATES.skillCheckAnimation, context);
  const host = document.createElement("div");
  host.className = "fallout-maw-skill-check-animation-host";
  host.innerHTML = content.trim();
  document.body.append(host);

  const animationElement = host.querySelector("[data-skill-check-animation]");
  const cells = Array.from(host.querySelectorAll("[data-skill-check-animation-cell]"));
  if (!animationElement || !cells.length) {
    host.remove();
    throw new Error("Skill check animation template is missing required elements.");
  }

  await waitForAnimationFrame();
  if (context.autoFailure) {
    clearProgressCells(cells);
    activateProgressCells(cells, new Set(), cells.length, 100);
    animationElement.classList.add("complete");
    await waitForClick(animationElement);
    host.remove();
    return;
  }

  await animateSkillCheckCells(cells, context.progressTarget);
  animationElement.classList.add("complete");
  await waitForClick(animationElement);
  host.remove();
}

function animateSkillCheckCells(cells, target) {
  const targetPercent = clamp(target, 1, 100);
  const fastDuration = 1000;
  const brakeDuration = 500;
  const targetCellCount = Math.ceil(targetPercent / 5);
  const brakeCellCount = Math.max(1, Math.ceil(targetCellCount * 0.2));
  const fastCellCount = Math.max(0, targetCellCount - brakeCellCount);
  const targetCells = cells.slice(0, targetCellCount);
  clearProgressCells(cells);

  return new Promise(resolve => {
    const startedAt = performance.now();
    const activatedCells = new Set();
    const tick = now => {
      const elapsed = now - startedAt;
      let visibleCellCount = targetCellCount;
      if (elapsed <= fastDuration) {
        visibleCellCount = Math.floor(fastCellCount * (elapsed / fastDuration));
      } else if (elapsed < fastDuration + brakeDuration) {
        const brakeProgress = (elapsed - fastDuration) / brakeDuration;
        const eased = 1 - ((1 - brakeProgress) ** 3);
        visibleCellCount = fastCellCount + Math.floor(brakeCellCount * eased);
      }

      activateProgressCells(targetCells, activatedCells, visibleCellCount, targetPercent);
      if (elapsed < fastDuration + brakeDuration) {
        requestAnimationFrame(tick);
        return;
      }
      activateProgressCells(targetCells, activatedCells, targetCellCount, targetPercent);
      resolve();
    };
    requestAnimationFrame(tick);
  });
}

function clearProgressCells(cells) {
  for (const cell of cells) {
    cell.style.setProperty("--cell-fill", "0%");
    cell.classList.remove("filled");
  }
}

function activateProgressCells(cells, activatedCells, visibleCellCount, targetPercent) {
  const count = clamp(Math.floor(visibleCellCount), 0, cells.length);
  for (let index = 0; index < count; index += 1) {
    const cell = cells[index];
    if (activatedCells.has(cell)) continue;
    activatedCells.add(cell);
    cell.style.setProperty("--cell-fill", `${getFinalCellFill(cell, targetPercent)}%`);
    cell.classList.add("filled");
  }
}

function getFinalCellFill(cell, targetPercent) {
  const start = Number(cell.dataset.cellStart) || 0;
  const end = Number(cell.dataset.cellEnd) || start;
  const width = Math.max(1, end - start);
  return clamp(((targetPercent - start) / width) * 100, 0, 100);
}

function waitForAnimationFrame() {
  return new Promise(resolve => requestAnimationFrame(resolve));
}

function waitForClick(element) {
  return new Promise(resolve => {
    element.addEventListener("click", resolve, { once: true });
  });
}

function resolveSkill(actor, skillKey) {
  const normalizedSkillKey = String(skillKey ?? "").trim();
  const setting = getSkillSettings().find(skill => skill.key === normalizedSkillKey);
  const actorSkill = actor.system?.skills?.[normalizedSkillKey];
  if (!setting || !actorSkill) return null;
  return {
    key: setting.key,
    abbr: setting.abbr,
    label: setting.label,
    value: toInteger(actorSkill.value)
  };
}

function normalizeRequestData(data) {
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

function determineResult(roll, total, difficulty, critical, autoFailure = false) {
  if (autoFailure) {
    return {
      key: "failure",
      label: game.i18n.localize("FALLOUTMAW.SkillCheck.AutomaticFailure"),
      cssClass: "failure automatic-failure",
      autoFailure: true
    };
  }
  if (critical.failureMaximum > 0 && roll <= critical.failureMaximum) {
    return {
      key: "criticalFailure",
      label: game.i18n.localize("FALLOUTMAW.SkillCheck.CriticalFailure"),
      cssClass: "critical-failure",
      autoFailure: false
    };
  }
  if (critical.successMinimum <= 100 && roll >= critical.successMinimum) {
    return {
      key: "criticalSuccess",
      label: game.i18n.localize("FALLOUTMAW.SkillCheck.CriticalSuccess"),
      cssClass: "critical-success",
      autoFailure: false
    };
  }
  if (total >= toInteger(difficulty)) {
    return {
      key: "success",
      label: game.i18n.localize("FALLOUTMAW.SkillCheck.Success"),
      cssClass: "success",
      autoFailure: false
    };
  }
  return {
    key: "failure",
    label: game.i18n.localize(autoFailure ? "FALLOUTMAW.SkillCheck.AutomaticFailure" : "FALLOUTMAW.SkillCheck.Failure"),
    cssClass: "failure",
    autoFailure
  };
}

function isAutomaticFailure(finalSkillValue, difficulty) {
  return (toInteger(difficulty) - toInteger(finalSkillValue)) >= 100;
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

function formatEdgeMode(edge) {
  if (edge.rollMode === "advantage") return game.i18n.localize("FALLOUTMAW.SkillCheck.Advantage");
  if (edge.rollMode === "disadvantage") return game.i18n.localize("FALLOUTMAW.SkillCheck.Disadvantage");
  return game.i18n.localize("FALLOUTMAW.SkillCheck.Normal");
}

function buildRollEntries(rolls, selectedRoll, difficulty, critical, finalSkillValue) {
  const autoFailure = isAutomaticFailure(finalSkillValue, difficulty);
  return rolls.map((roll, index) => {
    const result = determineResult(
      roll.total,
      toInteger(finalSkillValue) + toInteger(roll.total),
      difficulty,
      critical,
      autoFailure
    );
    return {
      index: index + 1,
      total: roll.total,
      selected: roll === selectedRoll,
      result
    };
  });
}

function buildThresholdRows(difficulty, critical, finalSkillValue) {
  return buildThresholdDefinitions(difficulty, critical, finalSkillValue)
    .slice()
    .reverse()
    .map(definition => buildThresholdRow(definition.cssClass, definition.label, definition.minimum, definition.maximum))
    .filter(Boolean);
}

function buildScaleSegments(difficulty, critical, finalSkillValue, selectedRollTotal) {
  const roll = clamp(selectedRollTotal, 1, 100);
  return buildThresholdDefinitions(difficulty, critical, finalSkillValue)
    .map(definition => ({
      ...definition,
      active: roll >= definition.minimum && roll <= definition.maximum,
      width: (((definition.maximum - definition.minimum) + 1) / 100) * 100
    }));
}

function buildProgressCells(difficulty, critical, finalSkillValue) {
  const definitions = buildThresholdDefinitions(difficulty, critical, finalSkillValue);
  return Array.from({ length: 20 }, (_value, index) => {
    const start = index * 5;
    const end = start + 5;
    return {
      index: index + 1,
      start,
      end,
      gradient: buildProgressCellGradient(start, end, definitions)
    };
  });
}

function buildProgressCellGradient(cellStart, cellEnd, definitions) {
  const stops = [];
  for (const definition of definitions) {
    const rangeStart = definition.minimum - 1;
    const rangeEnd = definition.maximum;
    const overlapStart = Math.max(cellStart, rangeStart);
    const overlapEnd = Math.min(cellEnd, rangeEnd);
    if (overlapEnd <= overlapStart) continue;

    const color = getThresholdColorVariable(definition.cssClass);
    const localStart = ((overlapStart - cellStart) / (cellEnd - cellStart)) * 100;
    const localEnd = ((overlapEnd - cellStart) / (cellEnd - cellStart)) * 100;
    stops.push(`${color} ${formatPercent(localStart)} ${formatPercent(localEnd)}`);
  }

  return stops.length ? stops.join(", ") : "var(--fallout-maw-animation-muted) 0% 100%";
}

function getThresholdColorVariable(cssClass) {
  if (cssClass === "automatic-failure") return "var(--fallout-maw-animation-red)";
  if (cssClass === "critical-failure") return "var(--fallout-maw-animation-red)";
  if (cssClass === "failure") return "var(--fallout-maw-animation-orange)";
  if (cssClass === "success") return "var(--fallout-maw-animation-cyan)";
  if (cssClass === "critical-success") return "var(--fallout-maw-animation-green)";
  return "var(--fallout-maw-animation-muted)";
}

function formatPercent(value) {
  const rounded = Math.round(value * 100) / 100;
  return `${rounded}%`;
}

function buildThresholdDefinitions(difficulty, critical, finalSkillValue) {
  if (isAutomaticFailure(finalSkillValue, difficulty)) {
    return [
      buildThresholdDefinition(
        "automatic-failure",
        game.i18n.localize("FALLOUTMAW.SkillCheck.AutomaticFailure"),
        game.i18n.localize("FALLOUTMAW.SkillCheck.AutomaticFailureShort"),
        1,
        100
      )
    ];
  }

  const successMinimum = clamp(toInteger(difficulty) - toInteger(finalSkillValue), 1, 100);
  const criticalFailureMaximum = Math.min(critical.failureMaximum, 100);
  const criticalSuccessMinimum = Math.max(critical.successMinimum, 1);
  const failureMinimum = Math.max(1, criticalFailureMaximum + 1);
  const failureMaximum = Math.min(successMinimum - 1, criticalSuccessMinimum - 1);
  const normalSuccessMinimum = Math.max(successMinimum, criticalFailureMaximum + 1);
  const normalSuccessMaximum = Math.min(100, criticalSuccessMinimum - 1);

  return [
    buildThresholdDefinition("critical-failure", game.i18n.localize("FALLOUTMAW.SkillCheck.CriticalFailure"), game.i18n.localize("FALLOUTMAW.SkillCheck.CriticalFailureShort"), 1, criticalFailureMaximum),
    buildThresholdDefinition("failure", game.i18n.localize("FALLOUTMAW.SkillCheck.Failure"), game.i18n.localize("FALLOUTMAW.SkillCheck.FailureShort"), failureMinimum, failureMaximum),
    buildThresholdDefinition("success", game.i18n.localize("FALLOUTMAW.SkillCheck.Success"), game.i18n.localize("FALLOUTMAW.SkillCheck.SuccessShort"), normalSuccessMinimum, normalSuccessMaximum),
    buildThresholdDefinition("critical-success", game.i18n.localize("FALLOUTMAW.SkillCheck.CriticalSuccess"), game.i18n.localize("FALLOUTMAW.SkillCheck.CriticalSuccessShort"), criticalSuccessMinimum, 100)
  ].filter(Boolean);
}

function buildThresholdDefinition(cssClass, label, shortLabel, minimum, maximum) {
  if (maximum < minimum) return null;
  return {
    cssClass,
    label,
    shortLabel,
    minimum,
    maximum
  };
}

function buildThresholdRow(cssClass, label, minimum, maximum) {
  if (maximum < minimum) return null;
  return {
    cssClass,
    label,
    range: minimum === maximum ? String(minimum) : `${minimum}-${maximum}`
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}
