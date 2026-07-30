const TEXT_EDITING_INPUT_TYPES = new Set([
  "",
  "text",
  "number",
  "search",
  "email",
  "password",
  "tel",
  "url"
]);

export function createFormSelfRenderSuppressionController({
  renderContext = "updateItem"
} = {}) {
  const activeScalarSubmits = [];

  return {
    async run(event, operation) {
      if (typeof operation !== "function") {
        throw new TypeError("A form submit operation is required.");
      }
      if (!isScalarFormChange(event)) return operation();

      const submission = {
        name: String(event.target.name),
        value: String(event.target.value ?? "")
      };
      activeScalarSubmits.push(submission);
      try {
        return await operation();
      } finally {
        const index = activeScalarSubmits.indexOf(submission);
        if (index >= 0) activeScalarSubmits.splice(index, 1);
      }
    },

    shouldSuppress(candidateRenderContext, renderData) {
      if (!activeScalarSubmits.length || candidateRenderContext !== renderContext) return false;
      if (renderData === undefined) return true;
      return activeScalarSubmits.some(submission => (
        hasChangedPath(renderData, submission.name)
        && String(getChangedPathValue(renderData, submission.name) ?? "") === submission.value
      ));
    }
  };
}

export function isFormTextEditingControl(control) {
  if (!control || control.disabled || control.readOnly) return false;
  const tagName = String(control.tagName ?? "").toUpperCase();
  if (tagName === "TEXTAREA") return true;
  if (tagName !== "INPUT") return false;
  return TEXT_EDITING_INPUT_TYPES.has(String(control.type ?? "text").toLowerCase());
}

function isScalarFormChange(event) {
  if (event?.type !== "change") return false;
  const control = event.target;
  return Boolean(String(control?.name ?? "").trim()) && isFormTextEditingControl(control);
}

function hasChangedPath(data, path) {
  if (!data || typeof data !== "object" || !path) return false;
  if (Object.hasOwn(data, path)) return true;
  const segments = String(path).split(".");
  let current = data;
  for (const segment of segments) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, segment)) return false;
    current = current[segment];
  }
  return true;
}

function getChangedPathValue(data, path) {
  if (Object.hasOwn(data, path)) return data[path];
  return String(path).split(".").reduce((value, segment) => value?.[segment], data);
}
