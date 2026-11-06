import { DateTime } from 'luxon';
import type { Config } from '../../config.js';
import type { CalendarService } from './google.js';

/** Horarios de inicio dentro de `meetingWindow`, desde el siguiente día hábil, a lo sumo uno por día. */
export async function proposeSlots(cal: CalendarService, now: Date, config: Config, count = 3): Promise<Date[]> {
  const { meetingWindow: w, meetingMinutes: mins, tz } = config;
  const [sh, sm] = w.start.split(':').map(Number);
  const [eh, em] = w.end.split(':').map(Number);
  const today = DateTime.fromJSDate(now, { zone: tz }).startOf('day');
  const out: Date[] = [];
  for (let i = 1; i <= 30 && out.length < count; i++) {
    const day = today.plus({ days: i });
    if (!w.days.includes(day.weekday)) continue;
    const open = day.set({ hour: sh, minute: sm });
    const close = day.set({ hour: eh, minute: em });
    const busy = await cal.busy(open.toJSDate(), close.toJSDate());
    for (let s = open; s.plus({ minutes: mins }) <= close; s = s.plus({ minutes: 30 })) {
      const start = s.toMillis();
      const end = s.plus({ minutes: mins }).toMillis();
      if (busy.some((b) => b.start.getTime() < end && b.end.getTime() > start)) continue;
      out.push(s.toJSDate());
      break;
    }
  }
  return out;
}

/** p. ej. 'lunes 9/11 a las 10:00' */
export function formatSlot(d: Date, tz: string): string {
  return DateTime.fromJSDate(d, { zone: tz }).setLocale('es').toFormat("cccc d/M 'a las' HH:mm");
}
