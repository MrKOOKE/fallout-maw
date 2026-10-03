import { localize } from "../utils/i18n.mjs";

/** One click commits a visible choice; Escape and the frame's close button cancel. */
export async function chooseWithChips({ title, prompt = "", choices = [] } = {}) {
  const result = await foundry.applications.api.DialogV2.wait({
    classes: ["fallout-maw-choice-dialog", ...(choices.length === 1 ? ["fallout-maw-choice-single"] : [])],
    window: { title }, position: { width: choices.length > 1 ? 480 : 280 },
    content: prompt ? `<p>${escapeHtml(prompt)}</p>` : "",
    buttons: [...choices.map((choice, index) => ({
      action: `choice-${index}`, label: choice.label, class: "fallout-maw-choice-chip",
      disabled: Boolean(choice.reason), type: "button",
      callback: () => choice.value
    })), { action: "cancel", default: true, class: "fallout-maw-choice-cancel",
      label: localize("FALLOUTMAW.Common.Cancel", "Отмена"), callback: () => null }],
    render: (_event, dialog) => {
      // Keep Foundry's submit/close lifecycle, while displaying only the choices.
      // The frame's close button and Escape cancel without a redundant footer.
      const cancel = dialog.element.querySelector('[data-action="cancel"]');
      cancel.hidden = true;
      cancel.removeAttribute("autofocus");
      dialog.element.setAttribute("tabindex", "-1");
      dialog.element.focus({ preventScroll: true });
      dialog.element.addEventListener("keydown", event => {
        if (event.key === "Enter" && !event.target.closest?.(".fallout-maw-choice-chip")) event.preventDefault();
      });
      choices.forEach((choice, index) => {
        const button = dialog.element.querySelector(`[data-action="choice-${index}"]`);
        const text = document.createElement("span"), label = document.createElement("strong");
        label.textContent = choice.label; text.append(label);
        const detailText = choice.reason || choice.detail;
        if (detailText && String(detailText).trim() !== String(choice.label).trim()) {
          const detail = document.createElement("small"); detail.textContent = detailText; text.append(detail);
        }
        if (choice.img) {
          const img = document.createElement("img"); img.src = choice.img; img.alt = ""; button.replaceChildren(img, text);
        } else button.replaceChildren(text);
      });
    },
    modal: true, rejectClose: false
  });
  return result === "cancel" ? null : result;
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
