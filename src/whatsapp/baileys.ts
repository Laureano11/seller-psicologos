import makeWASocket, { DisconnectReason, useMultiFileAuthState, type WASocket } from 'baileys';
import type { Boom } from '@hapi/boom';
import pino from 'pino';
import type { IncomingMsg, WaStatus, WaTransport } from './transport.js';
import { parseUpsert } from './upsert.js';

const PN_SUFFIX = '@s.whatsapp.net';

export function createBaileysTransport(authDir: string): WaTransport {
  const incoming: ((m: IncomingMsg) => void)[] = [];
  const status: ((s: WaStatus) => void)[] = [];
  const emitStatus = (s: WaStatus) => status.forEach((cb) => cb(s));
  const logger = pino({ level: 'silent' });
  let sock: WASocket | undefined;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

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
          reconnectTimer = setTimeout(() => void connect().catch(() => emitStatus({ state: 'desconectado' })), 3000);
        }
      }
    });
    s.ev.on('messages.upsert', (ev) => {
      for (const m of parseUpsert(ev)) incoming.forEach((cb) => cb(m));
    });
  }

  return {
    async stop() {
      stopped = true;
      clearTimeout(reconnectTimer);
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
