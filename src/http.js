export class ApiError extends Error {
  constructor(status, method) {
    super(`Remote API returned HTTP ${status} for ${method}. Check access, identifiers, and provider configuration.`);
    this.status = status;
  }
}

// Never return raw error bodies or request headers: they may contain credentials.
export class Http {
  constructor(base, headers = {}, fetchImpl = globalThis.fetch) {
    const url = new URL(base);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('API base URL must be HTTPS without embedded credentials, query, or fragment.');
    }
    this.base = base.replace(/\/$/, '');
    this.headers = headers;
    this.fetch = fetchImpl;
  }
  async request(route, { method = 'GET', body, query = {}, contentType = 'application/json' } = {}) {
    if (!route.startsWith('/') || route.startsWith('//')) throw new Error('Invalid API route');
    const url = new URL(this.base + route);
    if (url.origin !== new URL(this.base).origin) throw new Error('Cross-origin API request rejected');
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    let response;
    try {
      response = await this.fetch(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { Accept: 'application/json', ...this.headers, ...(body === undefined ? {} : { 'Content-Type': contentType }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch { throw new Error(`Remote ${method} request failed or timed out. A write may have succeeded; reconcile before retrying.`); }
    if (!response.ok) throw new ApiError(response.status, method);
    if (response.status === 204) return null;
    const text = await response.text();
    if (text.length > 12_000_000) throw new Error('API response exceeds 12 MB limit; narrow the request.');
    try { return JSON.parse(text); } catch { throw new Error('API returned an invalid JSON response'); }
  }
}
