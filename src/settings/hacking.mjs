export const DEFAULT_HACKING_SKILL_KEY = "repair";

export const DEFAULT_HACKING_SETTINGS = Object.freeze({
  skillKey: DEFAULT_HACKING_SKILL_KEY
});

export function createDefaultHackingSettings() {
  return { ...DEFAULT_HACKING_SETTINGS };
}

export function normalizeHackingSettings(settings = {}, skillSettings = []) {
  const skills = Array.isArray(skillSettings) ? skillSettings : [];
  const requestedSkillKey = String(settings?.skillKey ?? "").trim();
  let firstSkillKey = "";
  let requestedSkillAvailable = false;
  let defaultSkillAvailable = false;

  for (const skill of skills) {
    const skillKey = String(skill?.key ?? "").trim();
    if (!skillKey) continue;
    firstSkillKey ||= skillKey;
    if (skillKey === requestedSkillKey) requestedSkillAvailable = true;
    if (skillKey === DEFAULT_HACKING_SKILL_KEY) defaultSkillAvailable = true;
  }

  return {
    skillKey: requestedSkillAvailable
      ? requestedSkillKey
      : (defaultSkillAvailable ? DEFAULT_HACKING_SKILL_KEY : (firstSkillKey || DEFAULT_HACKING_SKILL_KEY))
  };
}
