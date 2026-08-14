import { MODULE_ID } from "./constants.js";

let mermaid = null;
const selector = ".mermaid";

async function loadMermaid() {
    const dynamicImport = new Function('url', 'return import(url)')
    const esModule = await dynamicImport("https://cdn.jsdelivr.net/npm/mermaid/+esm"); /*webpackIgnore*/
    mermaid = esModule.default;
    mermaid.initialize({
        startOnLoad: false,
        theme: "base",
        themeVariables: {
            primaryColor: getComputedStyle(document.documentElement).getPropertyValue("--simple-quest-background-color"),
            primaryTextColor: getComputedStyle(document.documentElement).getPropertyValue("--simple-quest-text-0"),
            primaryBorderColor: getComputedStyle(document.documentElement).getPropertyValue("--simple-quest-text-4"),
            lineColor: getComputedStyle(document.documentElement).getPropertyValue("--simple-quest-text-4"),
            secondaryColor: getComputedStyle(document.documentElement).getPropertyValue("--simple-quest-background-color"),
            tertiaryColor: getComputedStyle(document.documentElement).getPropertyValue("--simple-quest-background-color"),
        },
    });
}

export async function setupMermaid() {
    if (!mermaid) await loadMermaid();
    mermaid.run({ querySelector: selector });
}

export function setMermaidHooks() {
    window.runMermaid = setupMermaid;
    Hooks.on("renderJournalPageSheet", (app, html, data) => {
        if (html.find(selector)) {
            setTimeout(() => {
                setupMermaid();
            }, 1);
        }
    });
    Hooks.on(`${MODULE_ID}.onSelectQuest`, (page, html) => {
        if (html.querySelector(selector)) setupMermaid();
    });
}
