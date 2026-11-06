import { DateTime } from 'luxon';

export type Window = { days: number[]; start: string; end: string };

const DAY_NAMES = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 'mon-fri 09:00-20:00' o 'mon,wed,fri 10:00-12:00' */
export function parseWindow(spec: string): Window {
  const m = spec.trim().toLowerCase().match(/^(\S+)\s+(\d{2}:\d{2})-(\d{2}:\d{2})$/);
  if (!m || !HHMM.test(m[2]) || !HHMM.test(m[3]) || m[2] >= m[3]) throw new Error(`Ventana inválida: "${spec}"`);
  const days = new Set<number>();
  for (const part of m[1].split(',')) {
    const [a, b = a] = part.split('-');
    const i = DAY_NAMES.indexOf(a);
    const j = DAY_NAMES.indexOf(b);
    if (i < 0 || j < 0 || j < i) throw new Error(`Ventana inválida: "${spec}"`);
    for (let k = i; k <= j; k++) days.add(k + 1);
  }
  return { days: [...days].sort((x, y) => x - y), start: m[2], end: m[3] };
}

const hhmm = (dt: DateTime) => dt.toFormat('HH:mm');

export function isInWindow(now: Date, w: Window, tz: string): boolean {
  const dt = DateTime.fromJSDate(now, { zone: tz });
  return w.days.includes(dt.weekday) && hhmm(dt) >= w.start && hhmm(dt) < w.end;
}

/** `now` si está dentro de la ventana; si no, el próximo inicio de ventana. */
export function nextSendTime(now: Date, w: Window, tz: string): Date {
  if (isInWindow(now, w, tz)) return now;
  const dt = DateTime.fromJSDate(now, { zone: tz });
  const [h, mi] = w.start.split(':').map(Number);
  for (let i = 0; i <= 8; i++) {
    const day = dt.plus({ days: i });
    if (!w.days.includes(day.weekday)) continue;
    const start = day.set({ hour: h, minute: mi, second: 0, millisecond: 0 });
    if (start.toMillis() > now.getTime()) return start.toJSDate();
  }
  throw new Error('Ventana sin días');
}
