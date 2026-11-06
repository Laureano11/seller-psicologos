import { parsePhoneNumberFromString } from 'libphonenumber-js';

/** Normaliza a dígitos E.164 sin '+', o null si no es un número válido. Móviles argentinos: 549 + área + número (10 dígitos). */
export function toWaId(raw: string): string | null {
  const trimmed = raw.trim();
  let d = trimmed.replace(/\D/g, '');
  if (!d) return null;

  // Internacional no argentino: validar con libphonenumber
  if (trimmed.startsWith('+') && !d.startsWith('54')) {
    const p = parsePhoneNumberFromString(trimmed);
    return p?.isValid() ? p.number.replace('+', '') : null;
  }

  if (d.startsWith('54')) d = d.slice(2);
  if (d.startsWith('9') && d.length === 11) d = d.slice(1);
  if (d.startsWith('0')) d = d.slice(1);
  // Prefijo móvil "15" después del código de área (2 a 4 dígitos)
  if (d.length === 12) {
    for (const a of [2, 3, 4]) {
      if (d.slice(a, a + 2) === '15') {
        d = d.slice(0, a) + d.slice(a + 2);
        break;
      }
    }
  }
  if (d.length !== 10 || d.startsWith('0')) return null;
  return '549' + d;
}
