const BRIDGE_SOURCE = 'event-capture-page-bridge';
const CONTENT_SOURCE = 'event-capture-content';
const MAX_BODY = 4000;

interface RequestMeta {
  url: string;
  method: string;
  status: number;
  body?: string;
}

let bodyAllowlist: RegExp[] = [];

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== CONTENT_SOURCE || data.kind !== 'config') return;
      if (!Array.isArray(data.bodyAllowlist)) return;
      bodyAllowlist = compilePatterns(data.bodyAllowlist);
    });

    patchFetch();
    patchXhr();
  },
});

function compilePatterns(patterns: unknown[]): RegExp[] {
  return patterns.flatMap((pattern) => {
    if (typeof pattern !== 'string') return [];
    try {
      return [new RegExp(pattern, 'i')];
    } catch {
      return [];
    }
  });
}

function shouldCaptureBody(url: string): boolean {
  return bodyAllowlist.some((pattern) => pattern.test(url));
}

function post(meta: RequestMeta): void {
  window.postMessage({ source: BRIDGE_SOURCE, kind: 'network', ...meta }, window.location.origin);
}

function patchFetch(): void {
  const originalFetch = window.fetch;
  if (typeof originalFetch !== 'function') return;

  const patched = async function (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();

    try {
      const response = await originalFetch.call(window, input as RequestInfo, init);
      void report(url, method, response.status, response);
      return response;
    } catch (error) {
      post({ url, method, status: 0 });
      throw error;
    }
  };

  window.fetch = patched as typeof window.fetch;
}

async function report(
  url: string,
  method: string,
  status: number,
  response?: Response,
): Promise<void> {
  let body: string | undefined;
  if (response && method !== 'GET' && status >= 200 && status < 300 && shouldCaptureBody(url)) {
    try {
      body = (await response.clone().text()).slice(0, MAX_BODY);
    } catch {
      body = undefined;
    }
  }

  const meta: RequestMeta = { url, method, status };
  if (body) meta.body = body;
  post(meta);
}

interface XhrMeta {
  method: string;
  url: string;
}

type TrackedXhr = XMLHttpRequest & { __ecMeta?: XhrMeta };

function patchXhr(): void {
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (
    this: TrackedXhr,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    this.__ecMeta = {
      method: method.toUpperCase(),
      url: typeof url === 'string' ? url : url.toString(),
    };
    return (originalOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XMLHttpRequest.prototype.open;

  XMLHttpRequest.prototype.send = function (this: TrackedXhr, ...args: unknown[]) {
    const meta = this.__ecMeta;
    if (meta) {
      this.addEventListener('loadend', () => {
        const message: RequestMeta = { url: meta.url, method: meta.method, status: this.status };
        if (
          meta.method !== 'GET' &&
          this.status >= 200 &&
          this.status < 300 &&
          shouldCaptureBody(meta.url)
        ) {
          try {
            if (!this.responseType || this.responseType === 'text') {
              message.body = (this.responseText ?? '').slice(0, MAX_BODY);
            }
          } catch {
            // responseText unavailable (binary/blob); skip the body.
          }
        }
        post(message);
      });
    }
    return (originalSend as (...args: unknown[]) => void).apply(this, args);
  } as typeof XMLHttpRequest.prototype.send;
}
