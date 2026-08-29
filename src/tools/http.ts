import { env } from "../config/env.js";

export interface FetchResult {
  ok: boolean;
  status: number;
  url: string;
  body: string;
  latencyMs: number;
  error?: string;
}

/** Per-host serialization + spacing. Politeness is a correctness property here:
 *  a hammered ATS returns 429s and the source looks dead when it is not. */
const hostQueues = new Map<string, Promise<unknown>>();
const MIN_HOST_INTERVAL_MS = 250;
const lastHit = new Map<string, number>();

/**
 * Hosts that need more room than an ATS API does.
 *
 * LinkedIn's guest endpoint is a public web page, not an API with a published
 * quota, and it answers a burst with a 429 that means "stop", not "wait a
 * moment". Enforcing the spacing here rather than inside the adapter means
 * every path to the host — search, description fetch, any later probe — is
 * bound by it, and no future caller can forget.
 */
const HOST_INTERVAL_MS: Record<string, number> = {
  "www.linkedin.com": 2600,
  "in.linkedin.com": 2600,
};

async function throttled<T>(host: string, fn: () => Promise<T>): Promise<T> {
  const prev = hostQueues.get(host) ?? Promise.resolve();
  const task = prev.then(async () => {
    const interval = HOST_INTERVAL_MS[host] ?? MIN_HOST_INTERVAL_MS;
    const since = Date.now() - (lastHit.get(host) ?? 0);
    // Jittered, so a long harvest does not read as a metronome.
    if (since < interval) await sleep(interval - since + Math.random() * 400);
    lastHit.set(host, Date.now());
    return fn();
  });
  hostQueues.set(
    host,
    task.catch(() => undefined),
  );
  return task;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface FetchOptions {
  timeoutMs?: number;
  /** Some public job boards expose their listing endpoint as a POST. */
  method?: "GET" | "POST";
  body?: string;
  /** Transport retries with backoff (§4). Schema failures are handled elsewhere. */
  retries?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  if (env.offline) {
    return { ok: false, status: 0, url, body: "", latencyMs: 0, error: "offline mode (JOBSEARCH_OFFLINE=1)" };
  }
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? env.httpTimeoutMs;
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return { ok: false, status: 0, url, body: "", latencyMs: 0, error: "invalid URL" };
  }

  let last: FetchResult | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const started = Date.now();
    const res = await throttled(host, () => once(url, timeoutMs, opts));
    res.latencyMs = Date.now() - started;
    if (res.ok) return res;
    last = res;
    // 4xx other than 429 will not change on retry.
    const retryable = res.status === 0 || res.status === 408 || res.status === 429 || res.status >= 500;
    if (!retryable || attempt === retries) break;
    await sleep(Math.min(8000, 500 * 2 ** attempt) + Math.random() * 250);
  }
  return last!;
}

async function once(url: string, timeoutMs: number, opts: FetchOptions): Promise<FetchResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onOuterAbort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      body: opts.body,
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "user-agent": env.userAgent,
        accept: "application/json, text/html;q=0.9, */*;q=0.8",
        ...opts.headers,
      },
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, url: res.url || url, body, latencyMs: 0 };
  } catch (err) {
    const message = (err as Error).name === "AbortError" ? `timeout after ${timeoutMs}ms` : (err as Error).message;
    return { ok: false, status: 0, url, body: "", latencyMs: 0, error: message };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<{ ok: boolean; data: T | null; res: FetchResult }> {
  const res = await fetchText(url, opts);
  if (!res.ok) return { ok: false, data: null, res };
  try {
    return { ok: true, data: JSON.parse(res.body) as T, res };
  } catch {
    return { ok: false, data: null, res: { ...res, ok: false, error: "response was not JSON" } };
  }
}

/** §2.8 — aggregator links are redirect chains that die. Resolve and verify. */
export async function resolveApplyUrl(url: string, opts: FetchOptions = {}): Promise<{ url: string; status: number; ok: boolean }> {
  const res = await fetchText(url, { ...opts, retries: 1 });
  return { url: res.url || url, status: res.status, ok: res.ok };
}
