import { FalloutMaWCalendarHooks, TimeKeeperStatus } from "../../constants";
import { TimestampToDateData } from "../utilities/date-time";
import type Calendar from "../calendar";
import { SC } from "../index";

export class Hook {
    /**
     * Emit a specific hook for other things to listen too. Data is put together within this function.
     * @param {FalloutMaWCalendarHooks} hook The hook to emit
     * @param {Calendar} calendar
     * @param param
     */
    public static emit(hook: FalloutMaWCalendarHooks, calendar: Calendar, param: any = undefined) {
        let data: any = {};
        if (hook === FalloutMaWCalendarHooks.DateTimeChange) {
            const timestamp = calendar.toSeconds();
            data["timestamp"] = timestamp;
            data["date"] = TimestampToDateData(timestamp, calendar);
            data["diff"] = param;
            data["moons"] = [];

            for (let i = 0; i < calendar.moons.length; i++) {
                const moon = calendar.moons[i];
                data.moons.push({
                    name: moon.name,
                    color: moon.color,
                    cycleLength: moon.cycleLength,
                    cycleDayAdjust: moon.cycleDayAdjust,
                    affectsLighting: moon.affectsLighting,
                    maxLightContribution: moon.maxLightContribution,
                    currentPhase: moon.getMoonPhase(calendar)
                });
            }
        } else if (hook === FalloutMaWCalendarHooks.ClockStartStop) {
            const status = calendar.timeKeeper.getStatus();
            data = {
                started: status === TimeKeeperStatus.Started,
                stopped: status === TimeKeeperStatus.Stopped,
                paused: status === TimeKeeperStatus.Paused
            };
        } else if (hook === FalloutMaWCalendarHooks.PrimaryGM) {
            data["isPrimaryGM"] = SC.primary;
        }
        Hooks.callAll(hook, data);
    }
}
