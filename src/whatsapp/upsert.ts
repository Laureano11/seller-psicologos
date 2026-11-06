import type { WAMessage } from 'baileys';
import type { IncomingMsg, MediaKind } from './transport.js';

const PN_SUFFIX = '@s.whatsapp.net';

/** Número (solo dígitos) de un JID de persona; null para grupos, estados, broadcast, newsletters o LIDs. */
export function jidToWaId(jid: string | null | undefined): string | null {
  if (!jid || !jid.endsWith(PN_SUFFIX)) return null;
  const user = jid.slice(0, -PN_SUFFIX.length).split(':')[0];
  return /^\d+$/.test(user) ? user : null;
}

export const MEDIA_PLACEHOLDER: Record<MediaKind, string> = {
  audio: '[audio]',
  imagen: '[imagen]',
  sticker: '[sticker]',
  documento: '[documento]',
  video: '[video]',
  no_soportado: '[mensaje no soportado]',
};

/** Envoltorios que Baileys usa para mensajes temporales, de una sola vista, editados, etc. */
const WRAPPERS = [
  'ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension',
  'documentWithCaptionMessage', 'editedMessage',
] as const;

/** Contenido que no es un mensaje del usuario (borrados, reacciones, claves, encuestas, etc.): se ignora. */
const IGNORED = new Set([
  'protocolMessage', 'reactionMessage', 'encReactionMessage', 'senderKeyDistributionMessage', 'messageContextInfo',
  'pollUpdateMessage', 'keepInChatMessage', 'pinInChatMessage', 'deviceSentMessage', 'callLogMesssage',
]);

const MEDIA_KEYS: Record<string, MediaKind> = {
  audioMessage: 'audio',
  imageMessage: 'imagen',
  stickerMessage: 'sticker',
  documentMessage: 'documento',
  videoMessage: 'video',
  ptvMessage: 'video',
};

type Content = Record<string, any>;

function unwrap(c: Content | null | undefined): Content | null {
  let cur = c ?? null;
  for (let i = 0; cur && i < 5; i++) {
    const w = WRAPPERS.find((k) => cur![k]?.message);
    if (!w) break;
    cur = cur[w].message as Content;
  }
  return cur;
}

/** Texto (o placeholder + tipo) de un mensaje; null si no es un mensaje del usuario. */
function contentOf(m: WAMessage): { text: string; media?: MediaKind } | null {
  const c = unwrap(m.message as Content | null | undefined);
  if (!c) return null;
  const text = c.conversation ?? c.extendedTextMessage?.text;
  if (typeof text === 'string' && text.trim()) return { text };
  const keys = Object.keys(c).filter((k) => c[k] != null && !IGNORED.has(k));
  if (keys.length === 0) return null;
  const key = keys.find((k) => MEDIA_KEYS[k]) ?? keys[0];
  const media = MEDIA_KEYS[key] ?? 'no_soportado';
  const caption = c[key]?.caption;
  const placeholder = MEDIA_PLACEHOLDER[media];
  return { text: typeof caption === 'string' && caption.trim() ? `${placeholder} ${caption.trim()}` : placeholder, media };
}

/**
 * Convierte un `messages.upsert` de Baileys en mensajes entrantes. Acepta `notify` y `append`
 * (Baileys 7 entrega como `append` lo recibido mientras estaba desconectado); el dedupe lo hace el gateway.
 */
export function parseUpsert(ev: { messages: WAMessage[]; type: string }, nowMs: number = Date.now()): IncomingMsg[] {
  if (ev.type !== 'notify' && ev.type !== 'append') return [];
  const out: IncomingMsg[] = [];
  for (const m of ev.messages) {
    const jid = m.key.remoteJid;
    // con LIDs, el número real puede venir en remoteJidAlt; si no hay número, se ignora
    const waId = jidToWaId(jid) ?? (jid?.endsWith('@lid') ? jidToWaId(m.key.remoteJidAlt) : null);
    if (!waId || !m.key.id) continue;
    const content = contentOf(m);
    if (!content) continue;
    const at = new Date(Number(m.messageTimestamp ?? 0) * 1000 || nowMs);
    out.push({ fromWaId: waId, text: content.text, id: m.key.id, at, fromMe: !!m.key.fromMe, ...(content.media ? { media: content.media } : {}) });
  }
  return out;
}
