import { toInteger } from "../../utils/numbers.mjs";

/** Combine stored bonuses and values modified by initial Active Effects. */
export function mergePreparedBonuses(source = {}, prepared = {}, { preparedBonusMode = "prepared" } = {}) {
  const keys = new Set([
    ...Object.keys(source ?? {}),
    ...Object.keys(prepared ?? {})
  ]);
  return Object.fromEntries(
    Array.from(keys).map(key => {
      const value = source?.[key] ?? prepared?.[key] ?? {};
      const sourceBonus = toInteger(source?.[key]?.bonus);
      const preparedBonus = toInteger(prepared?.[key]?.bonus ?? value?.bonus);
      return [
        key,
        {
          ...value,
          bonus: preparedBonusMode === "delta"
            ? preparedBonus - sourceBonus
            : preparedBonus
        }
      ];
    })
  );
}
