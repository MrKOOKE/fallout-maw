export function scaleFirstAidSignedValue(value = 0, multiplier = 1) {
  const number = Number(value) || 0;
  if (!number) return 0;
  const scaled = Math.floor(Math.abs(number) * Math.max(0, Number(multiplier) || 0));
  const finalValue = scaled < 1 ? 1 : scaled;
  return number < 0 ? -finalValue : finalValue;
}
