export function calculateCurrencyAmount(value, current = 0) {
  const match = String(value ?? "").replace(/\s/g, "").match(/^([+*/-]?)(\d+)$/);
  if (!match) return null;
  const amount = Number(match[2]);
  const base = Math.max(0, Math.trunc(Number(current) || 0));
  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(base)) return null;
  let result;
  switch (match[1]) {
    case "+": result = base + amount; break;
    case "-": result = base - amount; break;
    case "*": result = base * amount; break;
    case "/": result = amount ? Math.trunc(base / amount) : NaN; break;
    default: result = amount;
  }
  return Number.isSafeInteger(result) ? Math.max(0, result) : null;
}

export class CurrencyInputController {
  #abort = null;
  #root = null;
  #actor = null;
  #fields = new Set();

  bind(root, { actor, canEdit, onError = () => {} }) {
    const fields = new Set(root?.querySelectorAll("[data-currency-editor]") ?? []);
    if (root === this.#root && actor === this.#actor && fields.size === this.#fields.size
      && [...fields].every(field => this.#fields.has(field))) return;
    this.destroy();
    if (!root) return;
    this.#root = root;
    this.#actor = actor;
    this.#fields = fields;
    const Abort = root.ownerDocument?.defaultView?.AbortController ?? AbortController;
    this.#abort = new Abort();
    const { signal } = this.#abort;
    for (const field of fields) {
      const key = field.dataset.currencyEditor;
      const readAmount = () => Math.max(0, Math.trunc(Number(actor.system?.currencies?.[key]) || 0));
      let dirty = false, pending = false;
      field.readOnly = !canEdit();
      const restore = () => { field.value = String(readAmount()); dirty = false; };
      const commit = async () => {
        if (!dirty || pending) return;
        if (!canEdit()) { restore(); return; }
        const value = calculateCurrencyAmount(field.value, readAmount());
        if (value === null) { restore(); return; }
        dirty = false;
        field.value = String(value);
        if (value === readAmount()) return;
        pending = true;
        field.readOnly = true;
        try { await actor.update({ [`system.currencies.${key}`]: value }); }
        catch (error) { restore(); onError(error); }
        finally { pending = false; field.readOnly = !canEdit(); }
      };
      field.addEventListener("focus", () => { if (!dirty) restore(); field.select(); }, { signal });
      field.addEventListener("click", () => field.select(), { signal });
      field.addEventListener("input", () => { dirty = true; }, { signal });
      field.addEventListener("change", event => event.stopPropagation(), { signal });
      field.addEventListener("blur", () => { void commit(); }, { signal });
      field.addEventListener("keydown", event => {
        if (event.isComposing || !["Enter", "Escape"].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Escape") restore();
        else void commit();
        field.blur();
      }, { signal });
    }
    root.ownerDocument?.addEventListener("pointerdown", event => {
      const field = root.ownerDocument.activeElement;
      if (fields.has(field) && event.target !== field) field.blur();
    }, { signal, capture: true });
  }

  destroy() {
    this.#abort?.abort();
    this.#abort = null;
    this.#root = null;
    this.#actor = null;
    this.#fields.clear();
  }
}
