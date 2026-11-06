export type IncomingMsg = { fromWaId: string; text: string; id: string; at: Date; fromMe: boolean };

export type WaStatus = {
  state: 'conectando' | 'qr' | 'conectado' | 'desconectado' | 'sesion_cerrada';
  qr?: string;
};

export interface WaTransport {
  start(): Promise<void>;
  stop?(): Promise<void>;
  send(waId: string, text: string): Promise<string>;
  hasWhatsApp(waId: string): Promise<boolean>;
  onIncoming(cb: (m: IncomingMsg) => void): void;
  onStatus(cb: (s: WaStatus) => void): void;
}

export type FakeTransport = WaTransport & {
  sent: { waId: string; text: string }[];
  emitIncoming(m: IncomingMsg): void;
  emitStatus(s: WaStatus): void;
  whatsappNumbers: Set<string>;
  /** Si se setea, `send` falla con este error. */
  failWith?: Error;
  /** Hook que corre dentro de `send`, antes de devolver el id (simula el eco fromMe temprano). */
  onSend?: (id: string, waId: string, text: string) => void;
};

export function createFakeTransport(): FakeTransport {
  const incoming: ((m: IncomingMsg) => void)[] = [];
  const status: ((s: WaStatus) => void)[] = [];
  let n = 0;
  const t: FakeTransport = {
    sent: [],
    whatsappNumbers: new Set(),
    async start() {},
    async send(waId, text) {
      if (t.failWith) throw t.failWith;
      const id = `fake-${++n}`;
      t.sent.push({ waId, text });
      t.onSend?.(id, waId, text);
      return id;
    },
    async hasWhatsApp(waId) {
      return t.whatsappNumbers.has(waId);
    },
    onIncoming(cb) { incoming.push(cb); },
    onStatus(cb) { status.push(cb); },
    emitIncoming(m) { incoming.forEach((cb) => cb(m)); },
    emitStatus(s) { status.forEach((cb) => cb(s)); },
  };
  return t;
}
