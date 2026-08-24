import SocketBase from "./socket-base";
import { Hook } from "../api/hook";
import { SocketTypes } from "../../constants";
import type Calendar from "../calendar";

/**
 * Emit Hook Socket type that will emit the specified hook
 */
export default class EmitHookSocket extends SocketBase {
    constructor() {
        super();
    }

    /**
     * All clients will emit this passed in hook.
     * @param data
     * @param {Calendar} calendar
     */
    public async process(data: FalloutMaWCalendar.FalloutMaWCalendarSocket.Data, calendar: Calendar): Promise<boolean> {
        if (data.type === SocketTypes.emitHook) {
            const hook = (<FalloutMaWCalendar.FalloutMaWCalendarSocket.EmitHook>data.data).hook;
            if (hook) {
                Hook.emit(hook, calendar, (<FalloutMaWCalendar.FalloutMaWCalendarSocket.EmitHook>data.data).param);
            }
            return true;
        }
        return false;
    }
}
