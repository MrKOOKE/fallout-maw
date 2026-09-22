import { SYSTEM_ID } from "../constants.mjs";
import { getCraftItemSourceKeys } from "./craft-item-source.mjs";
import { resolveWorldItemSync } from "./world-items.mjs";

const clone = value => structuredClone(value?.toObject?.() ?? value);
const count = value => Math.max(0, Math.trunc(Number(value) || 0));
const ratio = resource => Number(resource?.max) > 0
  ? Math.min(1, Math.max(0, Number(resource.value) || 0) / Number(resource.max)) : 1;
const get = (object, path) => path.reduce((value, key) => value?.[key], object);

export function getCraftDisassemblyYield(item) {
  const functions = item?.system?.functions ?? {};
  const condition = functions.condition?.enabled ? 0.2 + 0.8 * ratio(functions.condition) : 1;
  const supplies = [];
  for (const key of ["firstAid", "needChange", "oneTimeUse"]) {
    if (functions[key]?.enabled && functions[key].charges) supplies.push(ratio(functions[key].charges));
  }
  if (functions.energySource?.enabled) supplies.push(ratio(functions.energySource.reserve));
  const selectedTool = functions.tool?.enabled ? functions.tool.toolKey : "";
  for (const [key, tool] of Object.entries(functions.tools ?? {})) {
    if ((selectedTool ? key === selectedTool : tool.enabled) && tool.consumptionMode !== "condition") supplies.push(ratio(tool.supply));
  }
  if (functions.tool?.enabled && functions.tool.supply && functions.tool.consumptionMode !== "condition") supplies.push(ratio(functions.tool.supply));
  return condition * Math.min(1, ...supplies);
}

export function scaleCraftDisassemblyOutputs(outputs, inputs, repetitions = 1) {
  const total = inputs.reduce((sum, input) => sum + input.quantity, 0);
  if (!total) return outputs.map(output => ({ ...output }));
  const multiplier = inputs.reduce((sum, input) => sum + getCraftDisassemblyYield(input.item) * input.quantity, 0) / total;
  repetitions = Math.max(1, count(repetitions));
  return outputs.map(output => ({ ...output, fullQuantity: output.quantity,
    quantity: Math.floor(output.quantity / repetitions * multiplier + 1e-9) * repetitions }));
}

function portable(item, sourceUuid = "") {
  const data = clone(item);
  for (const key of ["_id", "id", "uuid", "folder", "sort", "ownership"]) delete data[key];
  data.system ??= {};
  data.system.quantity = 1;
  data.system.stackParts = [];
  if (/^Item\.[^.]+$/.test(sourceUuid)) {
    data.flags ??= {};
    data.flags[SYSTEM_ID] ??= {};
    data.flags[SYSTEM_ID].sourceId = sourceUuid;
  }
  return data;
}

export function getCraftEmbeddedItems(item, { resolve = resolveWorldItemSync } = {}) {
  const result = [];
  function add(kind, path, sourceUuid, quantity, stored = null) {
    if (!quantity) return;
    const source = stored?.system ? stored : resolve(sourceUuid);
    sourceUuid = getCraftItemSourceKeys(source).values().next().value || sourceUuid;
    result.push({ kind, path, key: path.join("."), sourceUuid, quantity,
      data: source ? portable(source, sourceUuid) : null,
      name: source?.name ?? "Предмет не найден", img: source?.img ?? "icons/svg/item-bag.svg" });
  }
  function visit(value, path) {
    if (!value || typeof value !== "object") return;
    if (value.magazine) {
      const magazine = value.magazine;
      add("ammo", [...path, "magazine"], magazine.sourceItemUuid || magazine.sourceItemUuids?.[0] || "", count(magazine.value));
    }
    for (const [index, slot] of (value.moduleSlots ?? []).entries()) {
      if (slot.itemUuid || slot.itemData?.system) add("module", [...path, "moduleSlots", index], slot.itemUuid || "", 1, slot.itemData);
    }
    const installed = value.installedSource;
    if (installed?.sourceItemUuid || installed?.itemData?.system) {
      add("energy", [...path, "installedSource"], installed.sourceItemUuid || "", 1, installed.itemData);
      const entry = result.at(-1);
      if (entry?.data) {
        entry.data.system.functions ??= {};
        entry.data.system.functions.energySource ??= { enabled: true, class: installed.class || "D" };
        entry.data.system.functions.energySource.reserve = clone(installed.reserve ?? { value: 0, max: 0 });
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (["magazine", "moduleSlots", "installedSource", "itemData"].includes(key)) continue;
      if (child && typeof child === "object") visit(child, [...path, key]);
    }
  }
  visit(item?.system?.functions, ["system", "functions"]);
  return result;
}

function assignEmbedded(data, entry, source, quantity) {
  const target = get(data, entry.path);
  if (entry.kind === "ammo") {
    target.value = quantity;
    return;
  }
  if (entry.kind === "module") {
    target.itemUuid = quantity ? entry.sourceUuid : "";
    target.itemData = quantity ? portable(source, entry.sourceUuid) : {};
    return;
  }
  const consumer = get(data, entry.path.slice(0, -1));
  consumer.activeSourceUuid = quantity ? entry.sourceUuid : "";
  consumer.installedSource = quantity ? {
    sourceItemUuid: entry.sourceUuid, name: source.name, img: source.img,
    class: source.system?.functions?.energySource?.class ?? "D",
    itemData: portable(source, entry.sourceUuid),
    reserve: clone(source.system?.functions?.energySource?.reserve ?? { value: 0, max: 0 })
  } : { sourceItemUuid: "", name: "", img: "", class: "", itemData: {}, reserve: { value: 0, max: 0 } };
}

export function planCraftEmbeddedCreation(recipe, inventory, {
  quantity = 1, consumed = new Map(), selections = {}, resolve = resolveWorldItemSync,
  matches = (item, uuid) => getCraftItemSourceKeys(item).has(uuid)
} = {}) {
  const entries = getCraftEmbeddedItems(recipe, { resolve });
  if (!entries.length) return { specs: [{ data: portable(recipe, recipe.uuid), quantity }], requirements: [], chips: [] };
  const requirements = new Map(), specs = [], chips = new Map();
  const remaining = new Map(inventory.map(item => [item.id ?? item._id, Math.max(0, count(item.system?.quantity) - (consumed.get(item.id ?? item._id) ?? 0))]));
  const candidates = new Map(entries.map(entry => [entry.key, inventory.filter(item => !item.system?.locked && matches(item, entry.sourceUuid))]));
  for (const entry of entries) chips.set(entry.key, { ...entry, enabled: selections[entry.key] !== false, requested: entry.quantity * quantity, quantity: 0 });
  for (let unit = 0; unit < quantity; unit++) {
    const data = portable(recipe, recipe.uuid);
    for (const entry of entries) {
      const chip = chips.get(entry.key);
      let available = 0, installed = null;
      if (chip.enabled && entry.data) for (const item of candidates.get(entry.key)) {
        const id = item.id ?? item._id;
        const used = Math.min(remaining.get(id), entry.quantity - available);
        if (!used) continue;
        remaining.set(id, remaining.get(id) - used);
        available += used;
        installed = clone(item);
        const requirement = requirements.get(id) ?? { key: `embedded:${id}`, itemId: id, sourceUuid: entry.sourceUuid, sourceKeys: [entry.sourceUuid], quantity: 0 };
        requirement.quantity += used;
        requirements.set(id, requirement);
        if (available === entry.quantity) break;
      }
      assignEmbedded(data, entry, installed, available);
      chip.quantity += available;
    }
    specs.push({ data, quantity: 1 });
  }
  return { specs, requirements: [...requirements.values()], chips: [...chips.values()] };
}

export function getCraftEmbeddedReturns(inputs, options = {}) {
  return inputs.flatMap(({ item, quantity }) => getCraftEmbeddedItems(item, options).map(entry => ({
    ...entry, quantity: entry.quantity * quantity, embedded: true
  })));
}
