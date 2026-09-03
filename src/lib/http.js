import { env } from '../env.js';

export async function fetchWithTimeout(url, options = {}, timeoutMs = env.httpTimeoutMs) {
  const signal = options.signal ?? AbortSignal.timeout(timeoutMs);
  return fetch(url, { ...options, signal });
}

export async function getJson(url, options = {}) {
  const response = await fetchWithTimeout(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

export async function getText(url, options = {}) {
  const response = await fetchWithTimeout(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

export async function mapPool(items, concurrency, worker) {
  const output = new Array(items.length);
  let cursor = 0;

  async function runner() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        output[index] = await worker(items[index], index);
      } catch (error) {
        output[index] = { __error: error };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runner));
  return output;
}
