import { ChatTimestamp } from "./chat-timestamp";
import { GameSettings } from "../foundry-interfacing/game-settings";

export class Chat {
    public static init() {
        //Extend the ChatMessage export function so that we can add in the game time for each message to the exported list.
        const handler = {
            apply: function (target: () => string, thisArg: ChatMessage) {
                const origExport = target.apply(thisArg);
                const gameTime = GameSettings.Localize("FALLOUTMAW.Calendar.Chat.GameTimeExport").replace(
                    "{TIME}",
                    ChatTimestamp.getFormattedChatTimestamp(thisArg)
                );
                return origExport.replace("\n", `\n${gameTime}\n`);
            }
        };
        ChatMessage.prototype.export = new Proxy(ChatMessage.prototype.export, handler);
    }
    public static createChatMessage(chatMessage: ChatMessage) {
        ChatTimestamp.addGameTimeToMessage(chatMessage);
        return true;
    }

    public static onRenderChatMessage(chatMessage: ChatMessage, html: JQuery, data: ChatMessage.MessageData): void {
        ChatTimestamp.renderTimestamp(chatMessage, html);
    }
}
