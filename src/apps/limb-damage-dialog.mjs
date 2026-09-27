import { localize as auditLocalize, format as auditFormat } from "../utils/i18n.mjs";
import { TEMPLATES } from "../constants.mjs";
import { getDestroyedLimbStateLabel, isLimbDestroyed, requestDamageApplication, restoreDestroyedLimb } from "../combat/damage-hub.mjs";
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
      title: auditFormat("FALLOUTMAW.AuditApps.DamageAndHealing", { v0: (limb.label || limbKey) }, "{v0}: урон и лечение")
    },
    content,
    position: { width: 430 },
    rejectClose: false,
    ok: {
      label: auditLocalize("FALLOUTMAW.Common.Apply", "Применить"),
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
  const stateLabel = getDestroyedLimbStateLabel(actor, limbKey).toLocaleLowerCase(game.i18n?.lang ?? "ru");
  const actionLabel = actor?.type === "construct" ? auditLocalize("FALLOUTMAW.AuditApps.ThePartAndRestoreItsFunctions", "деталь и вернуть ее функции") : auditLocalize("FALLOUTMAW.AuditApps.TheBodyPartAndRestoreItsFunctions", "часть тела и вернуть ее функции");
  const confirmed = await DialogV2.confirm({
    window: {
      title: auditFormat("FALLOUTMAW.AuditApps.Restoration", { v0: (label) }, "{v0}: восстановление")
    },
    content: auditFormat("FALLOUTMAW.AuditApps.Restore", { v0: (label), v1: (stateLabel), v2: (actionLabel) }, "<p>{v0} {v1}. Восстановить {v2}?</p>"),
    yes: {
      label: auditLocalize("FALLOUTMAW.AuditApps.Restore_495", "Восстановить"),
      icon: "fa-solid fa-kit-medical"
    },
    no: {
      label: auditLocalize("FALLOUTMAW.Common.Cancel", "Отмена")
    },
    rejectClose: false
  });
  if (!confirmed) return undefined;
  return restoreDestroyedLimb(actor, limbKey);
}
