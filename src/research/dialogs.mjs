import { TEMPLATES } from "../constants.mjs";
import { getSkillSettings } from "../settings/accessors.mjs";
import { format, localize } from "../utils/i18n.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { applyResearchTime, finalizeResearch, getResearchCheckCount } from "./research.mjs";
import {
  RESEARCH_DEFAULT_DIFFICULTY,
  formatResearchValue,
  getResearchById
} from "./storage.mjs";

const { DialogV2 } = foundry.applications.api;
const FormDataExtended = foundry.applications.ux.FormDataExtended;
const { renderTemplate } = foundry.applications.handlebars;

export async function openCreateResearchDialog(actor) {
  const skills = buildSkillOptions();
  if (!skills.length) {
    ui.notifications.warn(localize("FALLOUTMAW.Messages.ResearchSkillMissing"));
    return null;
  }

  const content = await renderTemplate(TEMPLATES.research.createDialog, {
    skills,
    defaults: {
      difficulty: RESEARCH_DEFAULT_DIFFICULTY
    }
  });

  const formData = await DialogV2.input({
    window: {
      title: localize("FALLOUTMAW.Research.CreateTitle")
    },
    content,
    ok: {
      label: "FALLOUTMAW.Research.Start",
      icon: "fa-solid fa-flask"
    },
    position: {
      width: 420
    },
    rejectClose: false
  });

  if (!formData) return null;

  await actor.createResearch(normalizeResearchFormData(formData));
  ui.notifications.info(localize("FALLOUTMAW.Messages.ResearchCreated"));
  return true;
}

export async function openManageResearchDialog(actor, researchId) {
  const research = getResearchById(actor.system?.researches, researchId);
  if (!research) return null;

  const content = await renderTemplate(TEMPLATES.research.manageDialog, {
    research,
    skills: buildSkillOptions(research.skillKey)
  });

  const result = await DialogV2.wait({
    window: {
      title: format("FALLOUTMAW.Research.ManageTitle", { name: research.name })
    },
    content,
    buttons: [
      {
        action: "save",
        label: "FALLOUTMAW.Common.SaveChanges",
        icon: "fa-solid fa-floppy-disk",
        default: true,
        callback: (_event, button) => ({
          action: "save",
          data: new FormDataExtended(button.form).object
        })
      },
      {
        action: "cancel",
        label: "Cancel",
        icon: "fa-solid fa-xmark",
        type: "button"
      }
    ],
    position: {
      width: 440
    },
    rejectClose: false
  });

  if (!result || (result === "cancel")) return null;

  await actor.updateResearch(researchId, normalizeResearchFormData(result.data));
  ui.notifications.info(localize("FALLOUTMAW.Messages.ResearchUpdated"));
  return true;
}

export async function deleteResearchWithConfirm(actor, researchId) {
  const research = getResearchById(actor.system?.researches, researchId);
  if (!research) return null;

  const confirmed = await DialogV2.confirm({
    window: {
      title: format("FALLOUTMAW.Research.DeleteTitle", { name: research.name })
    },
    content: `<p>${format("FALLOUTMAW.Research.DeleteContent", { name: research.name })}</p>`,
    yes: {
      label: "Delete",
      icon: "fa-solid fa-trash"
    },
    no: {
      label: "Cancel"
    },
    rejectClose: false
  });

  if (!confirmed) return null;

  await actor.deleteResearch(researchId);
  ui.notifications.info(localize("FALLOUTMAW.Messages.ResearchDeleted"));
  return true;
}

export async function openResearchTimeDialog(actor, researchId) {
  const research = getResearchById(actor.system?.researches, researchId);
  if (!research) return null;

  const content = await renderTemplate(TEMPLATES.research.timeDialog, {
    research: {
      ...research,
      progressLabel: formatResearchValue(research.progress),
      targetLabel: formatResearchValue(research.target),
      difficulty: Math.max(0, toInteger(research.difficulty))
    }
  });

  const formData = await DialogV2.input({
    window: {
      title: format("FALLOUTMAW.Research.TimeTitle", { name: research.name })
    },
    content,
    ok: {
      label: "FALLOUTMAW.Research.ApplyTime",
      icon: "fa-solid fa-hourglass-half"
    },
    position: {
      width: 420
    },
    rejectClose: false
  });

  if (!formData) return null;

  const duration = normalizeResearchDuration(formData);
  const checks = getResearchCheckCount(duration);
  if (checks < 1) {
    ui.notifications.warn(localize("FALLOUTMAW.Messages.ResearchTimeRequired"));
    return null;
  }

  let summary;
  try {
    summary = await applyResearchTime(actor, researchId, duration);
  } catch (error) {
    ui.notifications.error(error.message);
    console.error(error);
    return null;
  }

  if (!summary) return null;

  ui.notifications.info(format("FALLOUTMAW.Messages.ResearchProgressApplied", {
    name: research.name,
    gain: summary.gainLabel,
    progress: summary.progressLabel,
    target: summary.targetLabel,
    checks: summary.checks
  }));
  return summary;
}

export async function completeResearch(actor, researchId) {
  const research = getResearchById(actor.system?.researches, researchId);
  if (!research || (Number(research.progress) < Number(research.target))) return null;

  const result = await finalizeResearch(actor, researchId);
  if (!result) return null;

  ui.notifications.info(format("FALLOUTMAW.Messages.ResearchCompleted", {
    actor: actor.name,
    name: result.research.name
  }));
  return result;
}

function buildSkillOptions(selectedSkillKey = "") {
  return getSkillSettings().map(skill => ({
    key: skill.key,
    label: skill.label,
    selected: skill.key === selectedSkillKey
  }));
}

function normalizeResearchFormData(data = {}) {
  return {
    name: String(data.name ?? "").trim(),
    skillKey: String(data.skillKey ?? "").trim(),
    progress: Number(data.progress) || 0,
    target: Math.max(1, Number(data.target) || 1),
    difficulty: Math.max(0, toInteger(data.difficulty ?? RESEARCH_DEFAULT_DIFFICULTY))
  };
}

function normalizeResearchDuration(data = {}) {
  return {
    hours: Math.max(0, toInteger(data.hours)),
    halfHour: Boolean(data.halfHour)
  };
}
