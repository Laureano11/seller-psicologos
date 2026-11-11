import { generateText, Output, type LanguageModel } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import { logEvent } from '../db/repo.js';

export type AgentName = 'vendedor' | 'analista';
export type ChatMessage = { role: 'user' | 'assistant'; content: string };

export interface Llm {
  text(a: { agent: AgentName; system: string; messages: ChatMessage[] }): Promise<string>;
  object<T>(a: { agent: AgentName; system: string; messages: ChatMessage[]; schema: z.ZodType<T> }): Promise<T>;
}

export class AllProvidersFailedError extends Error {
  constructor(
    message: string,
    public attempts: { spec: string; error: string }[],
  ) {
    super(message);
    this.name = 'AllProvidersFailedError';
  }
}

export function defaultModelFactory(spec: string): LanguageModel {
  const i = spec.indexOf(':');
  const provider = i < 0 ? spec : spec.slice(0, i);
  const model = i < 0 ? '' : spec.slice(i + 1);
  switch (provider) {
    case 'google':
      return createGoogleGenerativeAI()(model);
    case 'groq':
      return createGroq()(model);
    case 'openrouter':
      return createOpenAICompatible({
        name: 'openrouter',
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: process.env.OPENROUTER_API_KEY,
      })(model);
    case 'ollama':
      return createOpenAICompatible({
        name: 'ollama',
        baseURL: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1',
      })(model);
    case 'anthropic':
      return createAnthropic()(model);
    default:
      throw new Error(`Proveedor de IA desconocido: "${provider}" (en "${spec}")`);
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createLlm(config: Config, opts: { modelFactory?: (spec: string) => LanguageModel; db?: Db } = {}): Llm {
  const factory = opts.modelFactory ?? defaultModelFactory;

  async function withFallback<R>(agent: AgentName, run: (model: LanguageModel) => Promise<R>): Promise<R> {
    const specs = config.llm[agent];
    if (specs.length === 0) {
      throw new AllProvidersFailedError(
        `No hay modelos configurados para el agente "${agent}": falta definir LLM_${agent.toUpperCase()}`,
        [],
      );
    }
    const attempts: { spec: string; error: string }[] = [];
    for (const spec of specs) {
      try {
        return await run(factory(spec));
      } catch (e) {
        const error = errMsg(e);
        attempts.push({ spec, error });
        if (opts.db) {
          try {
            await logEvent(opts.db, 'llm_error', { agent, spec, error });
          } catch (logErr) {
            console.error('No se pudo registrar llm_error:', errMsg(logErr));
          }
        }
      }
    }
    throw new AllProvidersFailedError(
      `Fallaron todos los proveedores de IA para "${agent}": ${attempts.map((a) => `${a.spec} (${a.error})`).join('; ')}`,
      attempts,
    );
  }

  return {
    text: ({ agent, system, messages }) =>
      withFallback(agent, async (model) => (await generateText({ model, system, messages, maxRetries: 0 })).text),
    object: <T>({ agent, system, messages, schema }: { agent: AgentName; system: string; messages: ChatMessage[]; schema: z.ZodType<T> }) =>
      withFallback(agent, async (model) => {
        const res = await generateText({ model, system, messages, maxRetries: 0, output: Output.object({ schema }) });
        return res.output as T;
      }),
  };
}

export function createFakeLlm(
  handler: (a: { agent: AgentName; system: string; messages: ChatMessage[]; schema?: z.ZodType<unknown> }) => unknown | Promise<unknown>,
): Llm {
  return {
    text: async (a) => String(await handler(a)),
    object: async <T>(a: { agent: AgentName; system: string; messages: ChatMessage[]; schema: z.ZodType<T> }) =>
      a.schema.parse(await handler(a)),
  };
}
