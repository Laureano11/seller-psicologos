import { describe, it, expect } from 'vitest';
import type { WAMessage } from 'baileys';
import { parseUpsert } from '../src/whatsapp/upsert.js';

const P = '5491111111111';
const TS = 1_794_000_000; // segundos
const wa = (message: Record<string, unknown> | null, key: Partial<WAMessage['key']> = {}): WAMessage =>
  ({ key: { remoteJid: `${P}@s.whatsapp.net`, id: 'id-1', fromMe: false, ...key }, message, messageTimestamp: TS }) as WAMessage;

describe('parseUpsert', () => {
  it('notify con texto -> mensaje entrante', () => {
    expect(parseUpsert({ type: 'notify', messages: [wa({ conversation: 'hola' })] })).toEqual([
      { fromWaId: P, text: 'hola', id: 'id-1', at: new Date(TS * 1000), fromMe: false },
    ]);
  });

  it('append (mensajes recibidos durante la desconexión) también se procesa', () => {
    const r = parseUpsert({ type: 'append', messages: [wa({ extendedTextMessage: { text: 'te escribí anoche' } })] });
    expect(r).toMatchObject([{ fromWaId: P, text: 'te escribí anoche', fromMe: false }]);
  });

  it('otros tipos se ignoran', () => {
    expect(parseUpsert({ type: 'otro', messages: [wa({ conversation: 'hola' })] })).toEqual([]);
  });

  it('fromMe se marca (texto y no texto)', () => {
    const r = parseUpsert({
      type: 'notify',
      messages: [wa({ conversation: 'soy Lauri' }, { id: 'a', fromMe: true }), wa({ audioMessage: { seconds: 3 } }, { id: 'b', fromMe: true })],
    });
    expect(r).toMatchObject([
      { id: 'a', text: 'soy Lauri', fromMe: true },
      { id: 'b', text: '[audio]', fromMe: true, media: 'audio' },
    ]);
  });

  it('no texto -> placeholder y tipo (notify y append)', () => {
    const cases: [Record<string, unknown>, string, string][] = [
      [{ audioMessage: { ptt: true } }, '[audio]', 'audio'],
      [{ imageMessage: {} }, '[imagen]', 'imagen'],
      [{ stickerMessage: {} }, '[sticker]', 'sticker'],
      [{ documentMessage: {} }, '[documento]', 'documento'],
      [{ documentWithCaptionMessage: { message: { documentMessage: {} } } }, '[documento]', 'documento'],
      [{ videoMessage: {} }, '[video]', 'video'],
      [{ locationMessage: { degreesLatitude: 1 } }, '[mensaje no soportado]', 'no_soportado'],
      [{ contactMessage: { displayName: 'x' } }, '[mensaje no soportado]', 'no_soportado'],
    ];
    for (const type of ['notify', 'append']) {
      for (const [message, text, media] of cases) {
        expect(parseUpsert({ type, messages: [wa(message)] })).toMatchObject([{ text, media, fromMe: false }]);
      }
    }
  });

  it('imagen con texto incluye el epígrafe; temporales se desenvuelven', () => {
    expect(parseUpsert({ type: 'notify', messages: [wa({ imageMessage: { caption: 'mi consultorio' } })] }))
      .toMatchObject([{ text: '[imagen] mi consultorio', media: 'imagen' }]);
    const r = parseUpsert({ type: 'notify', messages: [wa({ ephemeralMessage: { message: { conversation: 'efímero' } } })] });
    expect(r).toMatchObject([{ text: 'efímero' }]);
    expect(r[0].media).toBeUndefined();
  });

  it('ignora reacciones, borrados, mensajes vacíos, grupos y sin id', () => {
    const r = parseUpsert({
      type: 'notify',
      messages: [
        wa({ reactionMessage: { text: '👍' } }),
        wa({ protocolMessage: { type: 0 } }),
        wa({ senderKeyDistributionMessage: {}, messageContextInfo: {} }),
        wa(null),
        wa({ conversation: 'grupo' }, { remoteJid: '1234@g.us' }),
        wa({ conversation: 'sin id' }, { id: undefined }),
        wa({ conversation: 'estado' }, { remoteJid: 'status@broadcast' }),
      ],
    });
    expect(r).toEqual([]);
  });

  it('LID con número alternativo usa remoteJidAlt', () => {
    const r = parseUpsert({ type: 'notify', messages: [wa({ conversation: 'hola' }, { remoteJid: '999@lid', remoteJidAlt: `${P}@s.whatsapp.net` })] });
    expect(r).toMatchObject([{ fromWaId: P }]);
  });
});
