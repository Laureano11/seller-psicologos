/** Chequeo simple de robots.txt: solo el grupo "User-agent: *", prefijos Disallow/Allow (gana el más largo). */

type Rule = { allow: boolean; path: string };

function parse(body: string): Rule[] {
  const rules: Rule[] = [];
  let agents: string[] = [];
  let inRules = false;
  for (const line of body.split(/\r?\n/)) {
    const clean = line.replace(/#.*/, '').trim();
    const i = clean.indexOf(':');
    if (i < 0) continue;
    const key = clean.slice(0, i).trim().toLowerCase();
    const value = clean.slice(i + 1).trim();
    if (key === 'user-agent') {
      if (inRules) { agents = []; inRules = false; }
      agents.push(value);
    } else if (key === 'allow' || key === 'disallow') {
      inRules = true;
      if (agents.includes('*') && value) rules.push({ allow: key === 'allow', path: value });
    }
  }
  return rules;
}

export function createRobotsChecker(fetchFn: typeof fetch = fetch): { allowed(url: string): Promise<boolean> } {
  const cache = new Map<string, Promise<Rule[]>>();
  const load = (origin: string) =>
    (async () => {
      try {
        const res = await fetchFn(`${origin}/robots.txt`, { signal: AbortSignal.timeout(5_000) });
        return res.ok ? parse(await res.text()) : [];
      } catch {
        return [];
      }
    })();
  return {
    async allowed(url) {
      let u: URL;
      try { u = new URL(url); } catch { return false; }
      if (!cache.has(u.origin)) cache.set(u.origin, load(u.origin));
      const rules = await cache.get(u.origin)!;
      const path = u.pathname + u.search;
      let best: Rule | undefined;
      for (const r of rules) if (path.startsWith(r.path) && (!best || r.path.length > best.path.length)) best = r;
      return best ? best.allow : true;
    },
  };
}
