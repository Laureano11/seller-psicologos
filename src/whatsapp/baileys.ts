import makeWASocket, { DisconnectReason, useMultiFileAuthState, type WASocket, type WAMessage } from 'baileys';
import type { Boom } from '@hapi/boom';
import pino from 'pino';
import type { IncomingMsg, WaStatus, WaTransport } from './transport.js';

const PN_SUFFIX = '@s.whatsapp.net';

/** Número (solo dígitos) de un JID de persona; null para grupos, estados, broadcast, newsletters o LIDs. */
function jidToWaId(jid: string | null | undefined): string | null {
  if (!jid || !jid.endsWith(PN_SUFFIX)) return null;
  const user = jid.slice(0, -PN_SUFFIX.length).split(':')[0];
  return /^\d+$/.test(user) ? user : null;
}

function textOf(m: WAMessage): string | null {
  const c = m.message;
  return c?.conversation ?? c?.extendedTextMessage?.text ?? null;
}

export function createBaileysTransport(authDir: string): WaTransport {
  const incoming: ((m: IncomingMsg) => void)[] = [];
  const status: ((s: WaStatus) => void)[] = [];
  const emitStatus = (s: WaStatus) => status.forEach((cb) => cb(s));
  const logger = pino({ level: 'silent' });
  let sock: WASocket | undefined;
  let stopped = false;

  async function connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    emitStatus({ state: 'conectando' });
    const s = makeWASocket({ auth: state, logger });
    sock = s;
    s.ev.on('creds.update', saveCreds);
    s.ev.on('connection.update', (u) => {
      if (u.qr) emitStatus({ state: 'qr', qr: u.qr });
      if (u.connection === 'open') emitStatus({ state: 'conectado' });
      if (u.connection === 'close') {
        const code = (u.lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          emitStatus({ state: 'sesion_cerrada' });
        } else {
          emitStatus({ state: 'desconectado' });
          if (stopped) return;
          setTimeout(() => void connect().catch(() => emitStatus({ state: 'desconectado' })), 3000);
        }
      }
    });
    s.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        const jid = m.key.remoteJid;
        // con LIDs, el número real puede venir en remoteJidAlt; si no hay número, se ignora
        const waId = jidToWaId(jid) ?? (jid?.endsWith('@lid') ? jidToWaId(m.key.remoteJidAlt) : null);
        const text = textOf(m);
        if (!waId || !text || !m.key.id) continue;
        const at = new Date(Number(m.messageTimestamp ?? 0) * 1000 || Date.now());
        incoming.forEach((cb) => cb({ fromWaId: waId, text, id: m.key.id!, at, fromMe: !!m.key.fromMe }));
      }
    });
  }

  return {
    async stop() {
      stopped = true;
      sock?.end(undefined);
    },
    start: connect,
    async send(waId, text) {
      if (!sock) throw new Error('WhatsApp no conectado');
      const r = await sock.sendMessage(`${waId}${PN_SUFFIX}`, { text });
      if (!r?.key.id) throw new Error('WhatsApp no devolvió id de mensaje');
      return r.key.id;
    },
    async hasWhatsApp(waId) {
      if (!sock) throw new Error('WhatsApp no conectado');
      const r = await sock.onWhatsApp(waId);
      return !!r?.[0]?.exists;
    },
    onIncoming(cb) { incoming.push(cb); },
    onStatus(cb) { status.push(cb); },
  };
}
