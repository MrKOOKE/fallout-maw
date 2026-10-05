import { getConstructVisualRuntimeConfig } from "./construct-visual-model.mjs";
import { getConstructSystems } from "./construct-systems.mjs";

/** An individual mount overrides its supplying system's generic rotation sound. */
export function getConstructRotationSoundProfiles(actor, slotIds = null) {
  const systems = getConstructSystems(actor);
  if (slotIds === null) return systems;
  const profiles = new Map();
  const parts = getConstructVisualRuntimeConfig(actor).parts;
  for (const slotId of slotIds) {
    const part = parts.find(row => row.slotId === slotId && row.rotates);
    if (!part) continue;
    const supplying = part.rotationSystemIds.length
      ? systems.filter(system => part.rotationSystemIds.includes(system.id)) : systems;
    if (part.rotationSoundPath) {
      const profile = { ...supplying[0], id: `rotation-part:${part.slotId}`, enabled: true,
        sounds: { rotate: { paths: [part.rotationSoundPath], volume: part.rotationSoundVolume } } };
      profiles.set(profile.id, profile);
    } else for (const system of supplying) profiles.set(system.id, system);
  }
  return [...profiles.values()];
}
