import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fillQuery } from './extract.js';

/** Lo que devuelve el agente de Claude por cada psicólogo (sin filtrar todavía). */
export type Hallazgo = { nombre: string; celular: string; email?: string; pagina: string };

/** Corre el agente con un prompt y devuelve lo que encontró. Lanza si no pudo correr. */
export type ClaudeRunner = (prompt: string) => Promise<Hallazgo[]>;

/** Versión fija del servidor de navegador (Playwright MCP, open source, sin claves). */
const PLAYWRIGHT_MCP = '@playwright/mcp@0.0.83';

const SCHEMA = {
  type: 'object',
  properties: {
    psicologos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          nombre: { type: 'string' },
          celular: { type: 'string' },
          email: { type: 'string' },
          pagina: { type: 'string', description: 'URL de la página donde figura el celular' },
        },
        required: ['nombre', 'celular', 'pagina'],
      },
    },
  },
  required: ['psicologos'],
};

export function buildPrompt(a: {
  instructions: string;
  queries: string[];
  city: { city: string; province: string };
  max: number;
  conocidos: string[];
}): string {
  const consultas = a.queries.map((q) => `- ${fillQuery(q, a.city)}`).join('\n');
  const conocidos = a.conocidos.length ? a.conocidos.join(', ') : '(ninguno)';
  return `${a.instructions}

Ciudad de esta corrida: ${a.city.city}, ${a.city.province}.
Consultas sugeridas (usalas en el buscador web, en este orden, hasta juntar suficientes):
${consultas}

Traé como máximo ${a.max} psicólogos nuevos.
Estos celulares ya los tenemos, no los traigas de nuevo: ${conocidos}`;
}

/** Saca la lista de la salida JSON de `claude -p --output-format json --json-schema`. */
export function parseClaudeOutput(stdout: string): Hallazgo[] {
  let out: { is_error?: boolean; result?: string; structured_output?: { psicologos?: unknown } };
  try {
    out = JSON.parse(stdout);
  } catch {
    throw new Error(`Claude no devolvió JSON: ${stdout.slice(0, 200)}`);
  }
  if (out.is_error) throw new Error(`Claude terminó con error: ${String(out.result ?? '').slice(0, 200)}`);
  const list = out.structured_output?.psicologos;
  if (!Array.isArray(list)) throw new Error('Claude no devolvió la lista de psicólogos');
  return list
    .filter((h): h is Record<string, unknown> => Boolean(h) && typeof h === 'object')
    .filter((h) => typeof h.nombre === 'string' && typeof h.celular === 'string' && typeof h.pagina === 'string')
    .map((h) => {
      const email = typeof h.email === 'string' ? h.email.trim() : '';
      const base = { nombre: (h.nombre as string).trim(), celular: (h.celular as string).trim(), pagina: (h.pagina as string).trim() };
      return email ? { ...base, email } : base;
    });
}

/**
 * Lanza `claude -p` con un navegador propio (perfil `profileDir`, nunca el Chrome personal) y solo las
 * herramientas del navegador. Usa la sesión de Claude Code ya logueada: no hace falta ninguna clave.
 */
export function createClaudeRunner(o: { profileDir: string; timeoutMs: number; maxTurns: number; model: string }): ClaudeRunner {
  const mcp = {
    mcpServers: {
      playwright: { command: 'npx', args: ['-y', PLAYWRIGHT_MCP, '--headless', '--user-data-dir', resolve(o.profileDir)] },
    },
  };
  return (prompt) =>
    new Promise((ok, fail) => {
      const child = spawn('claude', [
        '-p', prompt,
        '--output-format', 'json',
        '--json-schema', JSON.stringify(SCHEMA),
        '--mcp-config', JSON.stringify(mcp),
        '--strict-mcp-config',
        '--allowedTools', 'mcp__playwright',
        '--max-turns', String(o.maxTurns),
        '--model', o.model,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (b) => { stdout += b; });
      child.stderr.on('data', (b) => { stderr += b; });
      const timer = setTimeout(() => child.kill('SIGTERM'), o.timeoutMs);
      child.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        fail(e.code === 'ENOENT' ? new Error('No encuentro el comando `claude`. Instalá Claude Code y logueate con `claude`.') : e);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (signal) return fail(new Error(`Claude se cortó (${signal}): pasó el tiempo máximo de ${o.timeoutMs / 60000} min`));
        try {
          ok(parseClaudeOutput(stdout));
        } catch (e) {
          fail(code ? new Error(`Claude salió con código ${code}: ${(stderr || stdout).slice(0, 300)}`) : e);
        }
      });
    });
}
