import { TEMPLATES } from "../constants.mjs";
import { isLimbDestroyed, requestDamageApplication, restoreDestroyedLimb } from "../combat/damage-hub.mjs";
import { getDamageTypeSettings } from "../settings/accessors.mjs";
import { toInteger } from "../utils/numbers.mjs";

const { DialogV2 } = foundry.applications.api;
const FormDataExtended = foundry.applications.ux.FormDataExtended;
const { renderTemplate } = foundry.applications.handlebars;

export async function openLimbDamageDialog(actor, limbKey = "") {
  const limb = actor?.system?.limbs?.[limbKey];
  if (!actor || !limb) return undefined;
  if (!game.user?.isGM) return undefined;
  if (isLimbDestroyed(actor, limbKey)) return openLimbRestoreDialog(actor, limbKey, limb);

  const damageTypes = getDamageTypeSettings();
  const content = await renderTemplate(TEMPLATES.limbDamageDialog, {
    actor,
    limbKey,
    limb,
    damageTypes,
    defaultDamageTypeKey: damageTypes[0]?.key ?? "",
    amount: 0
  });

  return DialogV2.prompt({
    window: {
      title: `${limb.label || limbKey}: урон и лечение`
    },
    content,
    position: { width: 430 },
    rejectClose: false,
    ok: {
      label: "Применить",
      icon: "fa-solid fa-check",
      callback: (_event, button) => new FormDataExtended(button.form).object
    }
  }).then(data => {
    if (!data) return undefined;
    const amount = Math.max(0, toInteger(data.amount));
    if (!amount) return undefined;
    return requestDamageApplication({
      actor,
      limbKey,
      amount,
      damageTypeKey: data.damageTypeKey,
      mode: data.mode === "healing" ? "healing" : "damage",
      scope: "healthAndLimb",
      applyMitigation: false,
      processDamageTypeSettings: false,
      source: {
        requester: "limbDialog"
      }
    });
  });
}

async function openLimbRestoreDialog(actor, limbKey = "", limb = {}) {
  const label = String(limb?.label ?? limbKey);
  const confirmed = await DialogV2.confirm({
    window: {
      title: `${label}: восстановление`
    },
    content: `<p>${label} отсутствует. Восстановить часть тела и вернуть ее функции?</p>`,
    yes: {
      label: "Восстановить",
      icon: "fa-solid fa-kit-medical"
    },
    no: {
      label: "Отмена"
    },
    rejectClose: false
  });
  if (!confirmed) return undefined;
  return restoreDestroyedLimb(actor, limbKey);
}
