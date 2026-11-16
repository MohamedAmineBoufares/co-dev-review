// Models paste what the user gave them: a URL, "!306", "owner/repo#12", or a bare number.
// Accepting those removes a whole class of rejected first calls.
export const defaultProvider = config => (config.GITLAB_TOKEN || !config.GITHUB_TOKEN ? 'gitlab' : 'github');

export function parseTarget(value, config = {}) {
  if (value === undefined || value === null) return value;
  if (typeof value === 'number' || (typeof value === 'string' && /^\s*[!#]?\d+\s*$/.test(value))) {
    const provider = defaultProvider(config);
    return { provider, ...(provider === 'github' && config.GITHUB_REPO ? { project: config.GITHUB_REPO } : {}), number: Number(String(value).replace(/[^\d]/g, '')) };
  }
  if (typeof value === 'string') {
    const text = value.trim();
    const gitlab = /^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/(\d+)/i.exec(text);
    if (gitlab) return { provider: 'gitlab', project: decodeURIComponent(gitlab[1]), number: Number(gitlab[2]) };
    const github = /^https?:\/\/[^/]+\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i.exec(text);
    if (github) return { provider: 'github', project: github[1], number: Number(github[2]) };
    const short = /^(?:(gitlab|github)\s+)?([\w.-]+(?:\/[\w.-]+)+)\s*[#!\s]\s*(\d+)$/i.exec(text);
    if (short) return { provider: (short[1] ?? (text.includes('!') ? 'gitlab' : text.includes('#') ? 'github' : defaultProvider(config))).toLowerCase(), project: short[2], number: Number(short[3]) };
    try { return parseTarget(JSON.parse(text), config); } catch { return value; }
  }
  if (typeof value === 'object') {
    const number = typeof value.number === 'string' && /^\d+$/.test(value.number.trim()) ? Number(value.number) : value.number;
    return { ...value, provider: typeof value.provider === 'string' ? value.provider.toLowerCase() : defaultProvider(config), number };
  }
  return value;
}
