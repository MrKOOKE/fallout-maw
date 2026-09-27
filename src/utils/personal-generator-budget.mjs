import { localize as auditLocalize } from "./i18n.mjs";
const PRICE_SCALE = 1_000_000;

export function parseValueBudget(value) {
  const range = String(value ?? "").trim().match(/^(\d+)\s*-\s*(\d+)$/);
  if (range) {
    const bounds = range.slice(1).map(Number).sort((a, b) => a - b);
    return { min: bounds[0], max: bounds[1], range: true };
  }
  return { min: 0, max: Math.max(0, Math.trunc(Number(value) || 0)), range: false };
}

/** Select a reachable budget first, then sample a complete feasible quantity vector.
 * Default 1–1 quantities must already have been converted to optional, budget-limited quantities.
 * Quantities share the budget according to the weights of affordable alternatives.
 * Sampling each item's entire quantity range uniformly would give the first type
 * half the budget on average, however many alternatives exist. Shuffling alone
 * only changes which type dominates; it does not remove that bias.
 */
export function selectBudgetQuantities(entries, budget, random = Math.random) {
  const scaled = value => {
    const result = Math.round(value * PRICE_SCALE);
    if (!Number.isSafeInteger(result)) throw new RangeError(auditLocalize("FALLOUTMAW.AuditRuntime.R1309", "Слишком большая стоимость для подбора набора."));
    return result;
  };
  const minimum = scaled(budget.min);
  const maximum = scaled(budget.max);
  const quantities = entries.map(entry => entry.min);
  const prices = entries.map(entry => scaled(entry.price));
  const required = entries.reduce((sum, entry, i) => sum + prices[i] * entry.min, 0);
  if (required > maximum) return null;

  const active = entries.map((entry, index) => ({
    index, price: prices[index], capacity: entry.max - entry.min, weight: Math.max(1, entry.weight || 1)
  })).filter(entry => entry.price > 0 && entry.capacity > 0 && entry.price <= maximum - required);
  for (let i = active.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [active[i], active[j]] = [active[j], active[i]];
  }
  const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
  const unit = active.reduce((value, entry) => gcd(value, entry.price), 0) || 1;
  const ceiling = Math.floor((maximum - required) / unit);
  for (const entry of active) {
    entry.price /= unit;
    entry.capacity = Math.min(entry.capacity, Math.floor(ceiling / entry.price));
  }

  // Store reachable sums as disjoint inclusive intervals, not one Set entry per
  // sum. Dense budgets collapse into runs; sparse expensive items stay sparse.
  // Binary quantity groups also avoid a loop per copy of an inexpensive item.
  // Each suffix remains available to require a complete, affordable bundle.
  const suffix = new Array(active.length + 1);
  suffix[active.length] = [0, 0];
  for (let i = active.length - 1; i >= 0; i -= 1) {
    const entry = active[i];
    let reachable = suffix[i + 1];
    let left = entry.capacity;
    for (let group = 1; left > 0; group *= 2) {
      const count = Math.min(group, left);
      left -= count;
      reachable = unionShiftedIntervals(reachable, count * entry.price, ceiling);
    }
    suffix[i] = reachable;
  }

  const lower = Math.max(0, Math.ceil((minimum - required) / unit));
  const totals = [];
  for (let i = 0; i < suffix[0].length; i += 2) {
    if (suffix[0][i + 1] >= lower) totals.push(Math.max(lower, suffix[0][i]), suffix[0][i + 1]);
  }
  if (!totals.length) return null;
  // A range samples attainable sums inside both bounds. A single number is a cap:
  // use its closest attainable sum, without inventing fractional items.
  let remaining = budget.range ? sampleIntervalInteger(totals, random) : totals.at(-1);
  for (let i = 0; i < active.length; i += 1) {
    const entry = active[i];
    const options = [];
    const maxCount = Math.min(entry.capacity, Math.floor(remaining / entry.price));
    // Convert reachable suffix intervals directly into quantity intervals. A
    // million possible copies can be sampled without making a million options.
    const tail = suffix[i + 1];
    for (let j = tail.length - 2; j >= 0; j -= 2) {
      const low = Math.max(0, Math.ceil((remaining - tail[j + 1]) / entry.price));
      const high = Math.min(maxCount, Math.floor((remaining - tail[j]) / entry.price));
      if (low <= high) appendInterval(options, low, high);
    }
    let otherWeight = 0;
    for (let j = i + 1; j < active.length; j += 1) {
      if (active[j].price <= remaining) otherWeight += active[j].weight;
    }
    const selected = sampleBudgetQuantity(options, remaining / entry.price, entry.weight, otherWeight, random);
    quantities[entry.index] += selected;
    remaining -= selected * entry.price;
  }
  for (const [i, entry] of entries.entries()) {
    if (entry.price === 0) quantities[i] = entry.min + Math.floor(random() * (entry.max - entry.min + 1));
  }
  return quantities;
}

function appendInterval(intervals, low, high) {
  if (intervals.length && low <= intervals.at(-1) + 1) {
    intervals[intervals.length - 1] = Math.max(intervals.at(-1), high);
  } else intervals.push(low, high);
}

function unionShiftedIntervals(intervals, shift, ceiling) {
  const result = [];
  let original = 0;
  let shifted = 0;
  while (original < intervals.length || shifted < intervals.length) {
    const base = original < intervals.length ? intervals[original] : Infinity;
    const moved = shifted < intervals.length ? intervals[shifted] + shift : Infinity;
    if (Math.min(base, moved) > ceiling) break;
    if (base <= moved) {
      appendInterval(result, base, intervals[original + 1]);
      original += 2;
    } else {
      appendInterval(result, moved, Math.min(ceiling, intervals[shifted + 1] + shift));
      shifted += 2;
    }
  }
  return result;
}

// Uniform over reachable integers, without enumerating every possible budget.
function sampleIntervalInteger(intervals, random) {
  let total = 0;
  for (let i = 0; i < intervals.length; i += 2) {
    total += intervals[i + 1] - intervals[i] + 1;
  }
  let roll = random() * total;
  for (let i = 0; i < intervals.length; i += 2) {
    const count = intervals[i + 1] - intervals[i] + 1;
    if (roll < count) return Math.min(intervals[i + 1], intervals[i] + Math.floor(roll));
    roll -= count;
  }
  return intervals.at(-1);
}

function sampleBudgetQuantity(options, affordableCount, weight, otherWeight, random) {
  if (!otherWeight || options[0] === options.at(-1)) return options.at(-1);
  // Beta(1, otherWeight / weight): the expected budget share is weight /
  // (weight + otherWeight). All shares remain possible, including a large pile,
  // but a catalogue with many alternatives no longer gives every type a 50% share.
  const share = -Math.expm1(Math.log1p(-random()) * weight / otherWeight);
  const desired = share * affordableCount;
  if (desired <= options[0]) return options[0];
  if (desired >= options.at(-1)) return options.at(-1);
  for (let i = 0; i < options.length; i += 2) {
    if (desired > options[i + 1]) continue;
    // Stochastic rounding between feasible neighbors preserves small expected
    // quantities instead of rounding all small allocations down to zero.
    const lower = desired < options[i] ? options[i - 1] : Math.floor(desired);
    const upper = desired < options[i] ? options[i] : Math.ceil(desired);
    if (lower === upper) return lower;
    return random() < (desired - lower) / (upper - lower) ? upper : lower;
  }
  return options.at(-1);
}
