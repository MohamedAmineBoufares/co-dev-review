export class ApiError extends Error {
  constructor(status, method) {
    super(`Remote API returned HTTP ${status} for ${method}. Check access, identifiers, and provider configuration.`);
    this.status = status;
  }
}

// OpenSSL verification failures. Corporate proxies and endpoint antivirus (Zscaler, Kaspersky, Netskope…)
// re-sign HTTPS with their own CA, which Windows trusts but Node's bundled store does not.
const CERT_CODES = new Set(['SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED', 'CERT_UNTRUSTED', 'ERR_TLS_CERT_ALTNAME_INVALID']);
export const TLS_HINT = 'Node rejected the TLS certificate: something on this machine intercepts HTTPS. Export its root CA to a .pem file and start the server with NODE_EXTRA_CA_CERTS=<path>; verify with co-dev-review doctor.';

// Only the error code is exposed: the message and cause can carry the URL.
export class NetworkError extends Error {
  constructor(method, error) {
    const code = error?.cause?.code || (error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'TIMEOUT' : error?.code || 'UNKNOWN');
    const parts = [`Remote ${method} request failed (${code}).`];
    if (CERT_CODES.has(code)) parts.push(TLS_HINT);
    if (method !== 'GET') parts.push('A write may have succeeded; reconcile before retrying.');
    super(parts.join(' '));
    this.code = code;
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
    } catch (error) { throw new NetworkError(method, error); }
    if (!response.ok) throw new ApiError(response.status, method);
    if (response.status === 204) return null;
    const text = await response.text();
    if (text.length > 12_000_000) throw new Error('API response exceeds 12 MB limit; narrow the request.');
    try { return JSON.parse(text); } catch { throw new Error('API returned an invalid JSON response'); }
  }
}
