import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { MockLanguageModelV4 } from 'ai/test';
import { createLlm, createFakeLlm, defaultModelFactory, AllProvidersFailedError } from '../src/llm/llm.js';
import { createMemoryDb, migrate } from '../src/db/db.js';
import { listEvents } from '../src/db/repo.js';
import type { Db } from '../src/db/db.js';
import type { Config } from '../src/config.js';

const cfg = (llm: Partial<Config['llm']>) =>
  ({ llm: { vendedor: [], analista: [], ...llm } }) as Config;

const okModel = (text: string) =>
  new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }),
  });
const failModel = (status = 429) =>
  new MockLanguageModelV4({
    doGenerate: async () => {
      throw Object.assign(new Error(`HTTP ${status}`), { statusCode: status });
    },
  });

const args = { agent: 'vendedor' as const, system: 'sos un vendedor', messages: [{ role: 'user' as const, content: 'hola' }] };

describe('createLlm', () => {
  it('si el primer modelo da 429 usa el segundo', async () => {
    const models: Record<string, MockLanguageModelV4> = { 'a:x': failModel(), 'b:y': okModel('hola') };
    const llm = createLlm(cfg({ vendedor: ['a:x', 'b:y'] }), { modelFactory: (s) => models[s]! });
    expect(await llm.text(args)).toBe('hola');
  });

  it('si todos fallan lanza AllProvidersFailedError con los intentos y loguea cada fallo', async () => {
    const db = await createMemoryDb();
    await migrate(db);
    const llm = createLlm(cfg({ vendedor: ['a:x', 'b:y'] }), { modelFactory: () => failModel(), db });
    const err = await llm.text(args).catch((e) => e);
    expect(err).toBeInstanceOf(AllProvidersFailedError);
    expect(err.attempts).toHaveLength(2);
    expect(err.attempts[0].spec).toBe('a:x');
    expect(err.attempts[0].error).toMatch(/429/);
    const evs = await listEvents(db, 10);
    expect(evs.filter((e) => e.type === 'llm_error')).toHaveLength(2);
    await db.close();
  });

  it('si falla el registro en la base igual sigue con el próximo proveedor', async () => {
    const brokenDb = { query: async () => { throw new Error('db caída'); } } as unknown as Db;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const models: Record<string, MockLanguageModelV4> = { 'a:x': failModel(), 'b:y': okModel('hola') };
    const ok = createLlm(cfg({ vendedor: ['a:x', 'b:y'] }), { modelFactory: (s) => models[s]!, db: brokenDb });
    expect(await ok.text(args)).toBe('hola');
    const bad = createLlm(cfg({ vendedor: ['a:x', 'b:y'] }), { modelFactory: () => failModel(), db: brokenDb });
    const err = await bad.text(args).catch((e) => e);
    expect(err).toBeInstanceOf(AllProvidersFailedError);
    expect(err.attempts).toHaveLength(2);
    spy.mockRestore();
  });

  it('lista vacía: rechaza sin intentos y menciona la variable', async () => {
    const llm = createLlm(cfg({}), { modelFactory: () => okModel('x') });
    const err = await llm.text(args).catch((e) => e);
    expect(err).toBeInstanceOf(AllProvidersFailedError);
    expect(err.attempts).toHaveLength(0);
    expect(err.message).toMatch(/LLM_VENDEDOR/);
    await expect(llm.object({ ...args, schema: z.object({ ok: z.boolean() }) })).rejects.toBeInstanceOf(AllProvidersFailedError);
  });

  it('object devuelve el objeto validado', async () => {
    const llm = createLlm(cfg({ vendedor: ['a:x'] }), { modelFactory: () => okModel('{"ok":true}') });
    expect(await llm.object({ ...args, schema: z.object({ ok: z.boolean() }) })).toEqual({ ok: true });
  });

  it('object con salida inválida pasa al siguiente modelo', async () => {
    const models: Record<string, MockLanguageModelV4> = { 'a:x': okModel('no es json'), 'b:y': okModel('{"ok":false}') };
    const llm = createLlm(cfg({ vendedor: ['a:x', 'b:y'] }), { modelFactory: (s) => models[s]! });
    expect(await llm.object({ ...args, schema: z.object({ ok: z.boolean() }) })).toEqual({ ok: false });
  });
});

describe('defaultModelFactory', () => {
  it('proveedor desconocido lanza', () => {
    expect(() => defaultModelFactory('nope:modelo')).toThrow(/nope/);
  });
  it('proveedores conocidos devuelven un modelo', () => {
    for (const s of ['google:gemini-2.5-flash', 'groq:llama-3.3-70b-versatile', 'openrouter:foo/bar', 'ollama:llama3', 'anthropic:claude-sonnet-4-5']) {
      expect(defaultModelFactory(s)).toBeTruthy();
    }
  });
});

describe('createFakeLlm', () => {
  it('text devuelve String del resultado', async () => {
    expect(await createFakeLlm(() => 42).text(args)).toBe('42');
  });
  it('object valida con el schema y rechaza si no cumple', async () => {
    const schema = z.object({ ok: z.boolean() });
    expect(await createFakeLlm(() => ({ ok: true })).object({ ...args, schema })).toEqual({ ok: true });
    await expect(createFakeLlm(() => ({ ok: 'si' })).object({ ...args, schema })).rejects.toThrow();
  });
});
