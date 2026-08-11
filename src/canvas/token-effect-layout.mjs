const SQRT_THREE = Math.sqrt(3);
const ICON_FILL_SCALE = 0.9;
const MAX_SHRINK_STEPS = 16;
const BINARY_SEARCH_STEPS = 8;

/**
 * Build a column-major honeycomb of effect icons contained by a Token shape.
 * The short diameter matches Foundry's native effect size. Icons only shrink
 * when the Token contains more effects than the native-size honeycomb can hold.
 */
export function buildHexEffectLayout({
  width,
  height,
  centerX = width / 2,
  centerY = height / 2,
  shortDiameter,
  count = 0,
  columns = true,
  contains = null
} = {}) {
  const required = Math.max(0, Math.trunc(Number(count) || 0));
  const maximum = Math.max(0.001, Number(shortDiameter) || 0.001);
  const options = { width, height, centerX, centerY, columns, contains, limit: required };
  let layout = buildLayoutAtSize({ ...options, shortDiameter: maximum });
  if ((required === 0) || (layout.slots.length >= required)) return layout;

  let tooLarge = maximum;
  let fittingSize = maximum;
  let fittingLayout = layout;
  for (let step = 0; step < MAX_SHRINK_STEPS; step += 1) {
    const candidate = tooLarge * 0.75;
    const candidateLayout = buildLayoutAtSize({ ...options, shortDiameter: candidate });
    if (candidateLayout.slots.length >= required) {
      fittingSize = candidate;
      fittingLayout = candidateLayout;
      break;
    }
    tooLarge = candidate;
    layout = candidateLayout;
  }

  if (fittingLayout.slots.length < required) return layout;
  for (let step = 0; step < BINARY_SEARCH_STEPS; step += 1) {
    const candidate = (fittingSize + tooLarge) / 2;
    const candidateLayout = buildLayoutAtSize({ ...options, shortDiameter: candidate });
    if (candidateLayout.slots.length >= required) {
      fittingSize = candidate;
      fittingLayout = candidateLayout;
    } else {
      tooLarge = candidate;
    }
  }
  return fittingLayout;
}

/** Return a flat array of vertices for a flat-top or pointy-top hexagon. */
export function getHexEffectPolygonPoints(centerX, centerY, width, height, columns = true) {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const quarterWidth = width / 4;
  const quarterHeight = height / 4;
  if (columns) {
    return [
      centerX - halfWidth, centerY,
      centerX - quarterWidth, centerY - halfHeight,
      centerX + quarterWidth, centerY - halfHeight,
      centerX + halfWidth, centerY,
      centerX + quarterWidth, centerY + halfHeight,
      centerX - quarterWidth, centerY + halfHeight
    ];
  }
  return [
    centerX, centerY - halfHeight,
    centerX + halfWidth, centerY - quarterHeight,
    centerX + halfWidth, centerY + quarterHeight,
    centerX, centerY + halfHeight,
    centerX - halfWidth, centerY + quarterHeight,
    centerX - halfWidth, centerY - quarterHeight
  ];
}

function buildLayoutAtSize({
  width,
  height,
  centerX,
  centerY,
  shortDiameter,
  columns,
  contains,
  limit
}) {
  const boundsWidth = Math.max(0, Number(width) || 0);
  const boundsHeight = Math.max(0, Number(height) || 0);
  const short = Math.max(0.001, Number(shortDiameter) || 0.001);
  const cellWidth = columns ? (2 * short) / SQRT_THREE : short;
  const cellHeight = columns ? short : (2 * short) / SQRT_THREE;
  const iconWidth = cellWidth * ICON_FILL_SCALE;
  const iconHeight = cellHeight * ICON_FILL_SCALE;
  const slotLimit = Math.max(0, Math.trunc(Number(limit) || 0));
  const result = { cellWidth, cellHeight, iconWidth, iconHeight, slots: [] };
  if (!slotLimit) return result;
  const testContains = typeof contains === "function"
    ? contains
    : (x, y) => (x >= 0) && (x <= boundsWidth) && (y >= 0) && (y <= boundsHeight);

  const keepSlot = (x, y) => {
    if (
      ((x - (iconWidth / 2)) < 0)
      || ((x + (iconWidth / 2)) > boundsWidth)
      || ((y - (iconHeight / 2)) < 0)
      || ((y + (iconHeight / 2)) > boundsHeight)
    ) return false;

    const points = getHexEffectPolygonPoints(x, y, iconWidth, iconHeight, columns);
    for (let index = 0; index < points.length; index += 2) {
      if (!testContains(points[index], points[index + 1])) return false;
    }
    result.slots.push({ x, y });
    return result.slots.length >= slotLimit;
  };

  if (columns) {
    const qLimit = Math.ceil((boundsWidth + iconWidth) / (1.5 * cellWidth)) + 1;
    const rLimit = Math.ceil(((boundsHeight + iconHeight) / (2 * cellHeight)) + (qLimit / 2)) + 1;
    for (let q = -qLimit; q <= qLimit; q += 1) {
      const x = centerX + (0.75 * cellWidth * q);
      for (let r = -rLimit; r <= rLimit; r += 1) {
        const y = centerY + (cellHeight * (r + (q / 2)));
        if (keepSlot(x, y)) return result;
      }
    }
    return result;
  }

  // For pointy-top hexes, 2q+r identifies equal-x columns. Iterating that
  // integer first preserves the same left-to-right, then top-to-bottom order.
  const columnLimit = Math.ceil((boundsWidth + iconWidth) / cellWidth) + 1;
  const rLimit = Math.ceil((boundsHeight + iconHeight) / (1.5 * cellHeight)) + 1;
  for (let column = -columnLimit; column <= columnLimit; column += 1) {
    const x = centerX + ((cellWidth * column) / 2);
    for (let r = -rLimit; r <= rLimit; r += 1) {
      if (Math.abs(column - r) % 2) continue;
      const y = centerY + (0.75 * cellHeight * r);
      if (keepSlot(x, y)) return result;
    }
  }
  return result;
}
