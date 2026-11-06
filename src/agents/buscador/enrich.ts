import { z } from 'zod';
import type { Llm } from '../../llm/llm.js';
import type { RawProspect } from './sources.js';

export type Enrichment = {
  email?: string;
  whatsapp?: string;
  practiceType: 'individual' | 'equipo' | 'desconocido';
  toolsSignals: string;
  fitNotes: string;
  extra: Record<string, string>;
};

const empty = (): Enrichment => ({ practiceType: 'desconocido', toolsSignals: '', fitNotes: '', extra: {} });

const schema = z.object({
  email: z.string().optional(),
  whatsapp: z.string().optional(),
  practiceType: z.enum(['individual', 'equipo', 'desconocido']),
  toolsSignals: z.string(),
  fitNotes: z.string(),
  extra: z.record(z.string(), z.string()).default({}),
});

const SYSTEM = `Sos un asistente que analiza el sitio web de un psicólogo o consultorio de Argentina.
Del texto del sitio extraé: email de contacto, número de WhatsApp (si aparece), si atiende de forma individual o es un equipo/centro, y qué herramientas usa (turnos online, agenda, plataformas de videollamada, pagos).
En "toolsSignals" resumí en una frase las herramientas que se detectan; en "fitNotes" anotá brevemente qué tan buen candidato parece para una herramienta de gestión de turnos.
Cualquier otro dato útil (especialidad, obras sociales, redes) va en "extra" como pares clave/valor de texto.
No inventes datos: si algo no aparece, dejalo vacío o usá "desconocido".`;

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000);
}

export async function enrichFromWebsite(
  raw: RawProspect,
  deps: { llm: Llm; fetchFn?: typeof fetch },
): Promise<Enrichment> {
  if (!raw.website) return empty();
  let text: string;
  try {
    const res = await (deps.fetchFn ?? fetch)(raw.website, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return empty();
    text = htmlToText(await res.text());
  } catch {
    return empty();
  }
  if (!text) return empty();
  try {
    const out = await deps.llm.object({
      agent: 'buscador',
      system: SYSTEM,
      messages: [{ role: 'user', content: `Sitio de "${raw.name}" (${raw.website}):\n\n${text}` }],
      schema,
    });
    return {
      email: out.email || undefined,
      whatsapp: out.whatsapp || undefined,
      practiceType: out.practiceType,
      toolsSignals: out.toolsSignals,
      fitNotes: out.fitNotes,
      extra: out.extra,
    };
  } catch {
    return empty();
  }
}
