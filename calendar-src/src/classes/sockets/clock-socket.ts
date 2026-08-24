import SocketBase from "./socket-base";
import { GameWorldTimeIntegrations, SocketTypes, TimeKeeperStatus } from "../../constants";
import Renderer from "../renderer";
import { MainApplication } from "../index";
import type Calendar from "../calendar";

/**
 * Clock socket type, used to update the clock status
 */
export default class ClockSocket extends SocketBase {
    constructor() {
        super();
    }

    public async process(data: FalloutMaWCalendar.FalloutMaWCalendarSocket.Data, calendar: Calendar): Promise<boolean> {
        if (data.type === SocketTypes.clock) {
            const rawData: any = data.data;
            const payload: any = typeof rawData === "object" && rawData !== null ? rawData : { status: rawData };
            const status = <TimeKeeperStatus>payload.status;
            // This is processed by all players to update the animated clock
            calendar.timeKeeper.setStatus(status);
            MainApplication.clockClass = status;
            if (calendar.generalSettings.gameWorldTimeIntegration === GameWorldTimeIntegrations.None) {
                const timestamp = Number(payload.timestamp);
                if (Number.isFinite(timestamp) && timestamp !== calendar.toSeconds()) {
                    calendar.setDateTime(calendar.secondsToDate(timestamp), {
                        updateApp: false,
                        sync: false,
                        save: false,
                        bypassPermissionCheck: true
                    });
                }
                Renderer.Clock.UpdateListener(`fallout_maw_calendar_${calendar.id}_clock`, status);
            }
            return true;
        }
        return false;
    }
}
