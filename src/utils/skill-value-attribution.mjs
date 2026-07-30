import { composePreparedSkillValue } from "./skill-value.mjs";

/**
 * Mirror the prepared skill value composition used by the actor data model.
 * The caller may attribute each component separately before applying the limits.
 */
export function decomposePreparedSkillValue(skill = {}) {
  return composePreparedSkillValue(skill);
}
