import { deepMerge } from "../utilities/object";
import { GameSettings } from "../foundry-interfacing/game-settings";

export default class MultiSelect {
    private static defaultOptions: FalloutMaWCalendar.Renderer.MultiSelectOptions = {
        id: "",
        options: []
    };

    private static clickedElement = "";

    public static Render(options: FalloutMaWCalendar.Renderer.MultiSelectOptions = { id: "", options: [] }, open: boolean = false): string {
        options = deepMerge({}, this.defaultOptions, options);
        const selectedValues = options.options
            .filter((o) => {
                return o.selected;
            })
            .map((o) => {
                return o.value;
            })
            .join("|");
        const selectedText =
            options.options
                .filter((o) => {
                    return o.selected;
                })
                .map((o) => {
                    return o.text;
                })
                .join(", ") || GameSettings.Localize("FALLOUTMAW.Calendar.MultiSelect.NoneSelected");
        let html = `<div class="fallout-maw-calendar-multiselect"><input class="fallout-maw-calendar-multiselect-id" id="${options.id}" value="${selectedValues}" type="hidden" />`;
        html += `<input class="fallout-maw-calendar-render-options" type="hidden" value="${encodeURIComponent(JSON.stringify(options))}"/>`;

        html += `<button><div class="fallout-maw-calendar-selected-options">${selectedText}</div><i class="fa fa-chevron-down"></i></button><ul class="fallout-maw-calendar-multi-select-options ${
            open ? "fallout-maw-calendar-show" : ""
        }">`;
        for (let i = 0; i < options.options.length; i++) {
            html += `<li class="${options.options[i].disabled ? "fallout-maw-calendar-disabled" : ""} ${
                options.options[i].selected ? "fallout-maw-calendar-selected" : ""
            }" data-value="${options.options[i].value}"><span class="fa-solid ${
                options.options[i].selected ? "fa-square-check" : "fa-square"
            }"></span>${options.options[i].text}</li>`;
        }
        html += `</ul></div>`;
        return html;
    }

    public static ActivateListeners(multiSelectId: string, onOptionChange: (multiSelectId: string, value: string | null, selected: boolean) => void) {
        const multiSelect = document.getElementById(multiSelectId)?.parentElement;
        if (multiSelect) {
            multiSelect
                .querySelector("button")
                ?.addEventListener("click", MultiSelect.EventListener.bind(MultiSelect, multiSelectId, "button", onOptionChange));
            multiSelect.querySelectorAll("li").forEach((e) => {
                e.addEventListener("click", MultiSelect.EventListener.bind(MultiSelect, multiSelectId, "option", onOptionChange));
            });
        }
    }

    public static EventListener(
        multiSelectId: string,
        type: string,
        onOptionChange: (multiSelectId: string, value: string | null, selected: boolean) => void,
        event: Event
    ) {
        const multiSelect = document.getElementById(multiSelectId)?.parentElement;
        if (multiSelect) {
            if (type === "button") {
                MultiSelect.clickedElement = multiSelectId;
                const options = multiSelect.querySelector(".fallout-maw-calendar-multi-select-options");
                if (options) {
                    if (options.classList.contains("fallout-maw-calendar-show")) {
                        options.classList.remove("fallout-maw-calendar-show");
                    } else {
                        options.classList.add("fallout-maw-calendar-show");
                    }
                }
            } else if (type === "option") {
                event.stopPropagation();
                const target = (<HTMLElement>event.target)?.closest("li");
                let renderOptions: FalloutMaWCalendar.Renderer.MultiSelectOptions = { id: "", options: [] };
                const rawRenderOptions = (<HTMLInputElement>multiSelect.querySelector(".fallout-maw-calendar-render-options"))?.value;
                if (target && !(<HTMLElement>target).classList.contains("fallout-maw-calendar-disabled") && rawRenderOptions) {
                    renderOptions = JSON.parse(decodeURIComponent(rawRenderOptions));

                    const value = (<HTMLElement>target).getAttribute("data-value");
                    const selected = !(<HTMLElement>target).classList.contains("fallout-maw-calendar-selected");

                    const optionIndex = renderOptions.options.findIndex((o: FalloutMaWCalendar.Renderer.MultiSelectOption) => {
                        return o.value === value;
                    });
                    if (optionIndex > -1) {
                        renderOptions.options[optionIndex].selected = selected;
                        if (renderOptions.options[optionIndex].makeOthersMatch) {
                            renderOptions.options.forEach((o, index) => {
                                if (!o.static && index !== optionIndex) {
                                    o.selected = selected;
                                    o.disabled = selected;
                                }
                            });
                        }
                    }

                    const newHtml = MultiSelect.Render(renderOptions, true);
                    const temp = document.createElement("div");
                    temp.innerHTML = newHtml;
                    if (temp.firstChild) {
                        multiSelect.replaceWith(temp.firstChild);
                        MultiSelect.ActivateListeners(multiSelectId, onOptionChange);
                    }
                    if (onOptionChange) {
                        onOptionChange(multiSelectId, value, selected);
                    }
                }
            }
        }
    }

    public static BodyEventListener() {
        document.querySelectorAll(".fallout-maw-calendar-multiselect").forEach((ms) => {
            const msId = ms.querySelector(".fallout-maw-calendar-multiselect-id")?.id;
            if (msId) {
                if (msId !== MultiSelect.clickedElement) {
                    const options = ms.querySelector(".fallout-maw-calendar-multi-select-options");
                    if (options) {
                        options.classList.remove("fallout-maw-calendar-show");
                    }
                } else {
                    MultiSelect.clickedElement = "";
                }
            }
        });
    }
}
