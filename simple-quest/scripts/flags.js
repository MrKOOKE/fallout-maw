import { FLAG_ROOT, FLAG_SCOPE } from "./constants.js";

export function getSimpleQuestFlag(document, key) {
    return foundry.utils.getProperty(document.flags?.[FLAG_SCOPE]?.[FLAG_ROOT], key);
}

export function setSimpleQuestFlag(document, key, value) {
    return document.setFlag(FLAG_SCOPE, `${FLAG_ROOT}.${key}`, value);
}
