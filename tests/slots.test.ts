import { describe, it, expect } from 'vitest';
import { proposeSlots, formatSlot } from '../src/agents/agenda/slots.js';
import type { CalendarService } from '../src/agents/agenda/google.js';
import { parseWindow } from '../src/time.js';
import type { Config } from '../src/config.js';

const TZ = 'America/Argentina/Buenos_Aires';
const config = { meetingWindow: parseWindow('mon-fri 10:00-18:00'), meetingMinutes: 30, tz: TZ } as Config;
const at = (iso: string) => new Date(iso); // -03:00

describe('proposeSlots', () => {
  it('viernes con lunes 10-11 ocupado -> lunes 11:00, martes 10:00, miércoles 10:00', async () => {
    const cal: CalendarService = {
      busy: async (from, to) => {
        const b = { start: at('2026-11-09T10:00:00-03:00'), end: at('2026-11-09T11:00:00-03:00') };
        return b.start < to && b.end > from ? [b] : [];
      },
      createMeeting: async () => ({ eventId: '', meetLink: '' }),
    };
    const slots = await proposeSlots(cal, at('2026-11-06T15:00:00-03:00'), config);
    expect(slots.map((s) => s.toISOString())).toEqual([
      at('2026-11-09T11:00:00-03:00'), at('2026-11-10T10:00:00-03:00'), at('2026-11-11T10:00:00-03:00'),
    ].map((d) => d.toISOString()));
  });
});

describe('formatSlot', () => {
  it('formato en español', () => {
    expect(formatSlot(at('2026-11-09T10:00:00-03:00'), TZ)).toBe('lunes 9/11 a las 10:00');
  });
});
