import { localize } from "../utils/i18n.mjs";
import { enrichSettingDescription, prepareSettingDescription } from "../utils/setting-description.mjs";
import { activateDescriptionFormulaAutocomplete } from "./description-formula-autocomplete.mjs";

/** Keep the description on its form row so reordering and renaming preserve it. */
export async function editSettingsDescription(event, target) {
  event.preventDefault();
  const row = target.closest("[data-characteristic-row], [data-skill-row]");
  const field = row?.querySelector("[data-field='description']");
  if (!field) return;

  const label = row.querySelector("[data-field='label']")?.value?.trim();
  const heading = localize("FALLOUTMAW.Common.Description");
  const source = prepareSettingDescription(field.value);
  const content = await foundry.applications.handlebars.renderTemplate(
    "systems/fallout-maw/templates/settings/setting-description-dialog.hbs",
    { description: source, descriptionHTML: await enrichSettingDescription(source) }
  );
  const description = await foundry.applications.api.DialogV2.prompt({
    classes: ["fallout-maw", "fallout-maw-config-form"],
    window: { title: label ? `${heading}: ${label}` : heading, resizable: true },
    position: { width: 720 },
    content,
    render: (_event, dialog) => {
      const activate = () => activateDescriptionFormulaAutocomplete(dialog.element);
      activate();
      dialog.element.querySelector("prose-mirror")?.addEventListener("open", activate, { once: true });
    },
    rejectClose: false,
    ok: {
      label: localize("FALLOUTMAW.Common.SaveChanges"),
      icon: "fa-solid fa-save",
      callback: (_event, button) => button.form.querySelector("prose-mirror[name='description']").value
    }
  });
  if (typeof description === "string") field.value = description;
}
