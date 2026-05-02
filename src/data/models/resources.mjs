const { NumberField, SchemaField } = foundry.data.fields;

export function resourceField(value = 0, max = value, options = {}) {
  return new SchemaField({
    min: new NumberField({ required: true, integer: true, initial: 0 }),
    spent: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
    value: new NumberField({ required: true, integer: true, initial: value }),
    max: new NumberField({ required: true, integer: true, initial: max })
  }, options);
}

export function clampPreparedResource(resource) {
  if (!resource) return;
  const min = Number(resource.min) || 0;
  const max = Math.max(Number(resource.max) || min, min);
  resource.max = max;
  resource.value = Math.min(Math.max(Number(resource.value) || min, min), max);
}

export function setResourceMaximum(resource, value) {
  if (!resource) return;
  resource.max = Math.max(Number(resource.min) || 0, toInteger(value));
}

function toInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}
