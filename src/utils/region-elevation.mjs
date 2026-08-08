import { SYSTEM_ID } from "../constants.mjs";

export const SPHERICAL_REGION_ELEVATION_FLAG = "sphericalRegionElevation";

export function getSphericalRegionElevation(centerElevation = 0, radiusPixels = 0, scene = null) {
  const center = Number.isFinite(Number(centerElevation)) ? Number(centerElevation) : 0;
  const gridDistance = Math.max(
    0.0001,
    Number(scene?.grid?.distance ?? globalThis.canvas?.scene?.grid?.distance ?? globalThis.canvas?.grid?.distance) || 1
  );
  const gridSize = Math.max(
    1,
    Number(scene?.grid?.size ?? globalThis.canvas?.grid?.size) || 100
  );
  const radius = Math.max(0, Number(radiusPixels) || 0) * (gridDistance / gridSize);
  return {
    bottom: center - radius,
    top: center + radius
  };
}

export function getSphericalRegionFlags(centerElevation = 0) {
  const center = Number.isFinite(Number(centerElevation)) ? Number(centerElevation) : 0;
  return {
    [SYSTEM_ID]: {
      [SPHERICAL_REGION_ELEVATION_FLAG]: { centerElevation: center }
    }
  };
}

export function getSphericalRegionCenterElevation(region = null) {
  const data = region?.getFlag?.(SYSTEM_ID, SPHERICAL_REGION_ELEVATION_FLAG);
  if (!data || !Number.isFinite(Number(data.centerElevation))) return null;
  return Number(data.centerElevation);
}

export function getMaximumCircleRadiusPixels(shapes = []) {
  let radius = 0;
  for (const shape of shapes ?? []) {
    const data = shape?.toObject ? shape.toObject() : shape;
    if (data?.type !== "circle") continue;
    radius = Math.max(radius, Math.max(0, Number(data.radius) || 0));
  }
  return radius;
}
