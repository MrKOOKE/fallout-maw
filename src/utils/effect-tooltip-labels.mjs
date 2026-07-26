const BONUS_WORD = /(^|[\s([{:;,])(?:bonus(?:es)?|бонус(?:а|у|ом|е|ы|ов|ам|ами|ах)?)(?=$|[\s)\]}:;,.!?])/giu;

export function stripEffectTooltipBonusWords(value = "") {
  const source = String(value ?? "");
  const cleaned = source
    .replace(BONUS_WORD, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([:;,.!?])/g, "$1")
    .replace(/^[\s:;,.-]+|[\s:;,.-]+$/g, "")
    .trim();
  if (!cleaned) return "";
  return `${cleaned.charAt(0).toLocaleUpperCase()}${cleaned.slice(1)}`;
}
