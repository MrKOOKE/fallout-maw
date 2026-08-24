import { ModuleName } from "../constants";
import { MainApplication } from "./index";

export default class KeyBindings {
    public static register() {
        game.keybindings?.register(ModuleName, "toggleMainApp", {
            name: "FALLOUTMAW.Calendar.KeyBinding.Toggle.Title",
            hint: "FALLOUTMAW.Calendar.KeyBinding.Toggle.Hint",
            editable: [
                {
                    key: "Z",
                    modifiers: []
                }
            ],
            onDown: MainApplication.toggleWindow.bind(MainApplication),
            precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL
        });
    }
}
