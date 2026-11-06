import { z } from 'zod';
import type { Prospect } from '../../db/repo.js';
import type { Knowledge } from './knowledge.js';

export const VendedorDecision = z.object({
  action: z.enum(['responder', 'escalar_pregunta', 'listo_para_cerrar', 'sospecha_bot', 'ofrecer_reunion', 'agendar_reunion', 'baja', 'rechazo']),
  message: z.string().nullable(),
  question: z.string().nullable(),
  meeting: z.object({ slotIso: z.string(), email: z.string() }).nullable(),
  evaluation: z.object({
    stage: z.enum(['iniciando', 'interesado', 'dudando', 'convencido', 'frio']),
    summary: z.string(),
  }),
  objections: z.array(z.string()),
});
export type VendedorDecision = z.infer<typeof VendedorDecision>;

export function prospectCard(p: Prospect): string {
  return [
    `Nombre: ${p.name}`,
    p.practiceType && `Tipo de práctica: ${p.practiceType}`,
    p.city && `Ciudad: ${p.city}`,
    p.toolsSignals && `Herramientas que usa: ${p.toolsSignals}`,
    p.fitNotes && `Notas: ${p.fitNotes}`,
  ].filter(Boolean).join('\n');
}

export function buildSystemPrompt(k: Knowledge, prospect: Prospect, ownerName: string): string {
  const faq = k.faq.length ? k.faq.map((f) => `P: ${f.question}\nR: ${f.answer}`).join('\n\n') : '(todavía no hay)';
  return `Sos ${ownerName} y charlás por WhatsApp con psicólogos para venderles un CRM. Sos flexible y nada agresivo. Tu objetivo es vender; la reunión es opcional, solo si la persona la quiere.

ESTILO (escribí exactamente así):
${k.estilo}

MANUAL DE VENTAS:
${k.ventas}

PRODUCTO:
${k.producto}

PREGUNTAS FRECUENTES:
${faq}

FICHA DEL PROSPECTO:
${prospectCard(prospect)}

Reglas:
- Nunca inventes precios ni funciones. Si no sabés algo, usá la acción "escalar_pregunta" con la pregunta en "question" y un "message" neutral (por ejemplo, que lo averiguás y le contestás).
- Si te preguntan o sospechan que sos un bot, usá "sospecha_bot" sin "message".
- Si quiere comprar, usá "listo_para_cerrar" sin "message".
- Si pide que no le escribas más, usá "baja" (con una despedida breve en "message").
- Si no le interesa, usá "rechazo". Si quiere una reunión, "ofrecer_reunion"; para confirmarla, "agendar_reunion" con "meeting" (slotIso de un horario ofrecido y su email).
- En cualquier otro caso, "responder" con un mensaje corto.
- Siempre completá "evaluation" (stage y summary) y "objections" (lista, vacía si no hay).`;
}
