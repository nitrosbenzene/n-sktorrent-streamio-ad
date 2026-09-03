import { AsyncLocalStorage } from 'node:async_hooks';

function int(name, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw == null) return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

export const env = Object.freeze({
  addonName: process.env.ADDON_NAME || 'SK Stream Bridge',
  addonId: process.env.ADDON_ID || 'io.streambridge.sktorrent',
  port: int('PORT', 7000, 1, 65535),
  configSecret: process.env.CONFIG_SECRET || '',
  sktUid: process.env.SKT_UID || '',
  sktPass: process.env.SKT_PASS || '',
  torboxKey: process.env.TORBOX_API_KEY || '',
  tmdbKey: process.env.TMDB_API_KEY || '',
  movieSearchPages: int('MOVIE_SEARCH_PAGES', 6, 1, 20),
  seriesSearchPages: int('SERIES_SEARCH_PAGES', 10, 1, 20),
  maxTorrentsToInspect: int('MAX_TORRENTS_TO_INSPECT', 24, 1, 80),
  torrentFetchConcurrency: int('TORRENT_FETCH_CONCURRENCY', 4, 1, 10),
  cacheTtlMs: int('CACHE_TTL_MS', 10 * 60_000, 5_000, 24 * 60 * 60_000),
  httpTimeoutMs: int('HTTP_TIMEOUT_MS', 8_000, 1_000, 30_000),
  torboxDirectLinks: bool('TORBOX_DIRECT_LINKS', true),
  torboxMaxDirectLinks: int('TORBOX_MAX_DIRECT_LINKS', 5, 0, 20)
});

const runtimeStorage = new AsyncLocalStorage();

function environmentConfig() {
  return {
    sktUid: env.sktUid,
    sktPass: env.sktPass,
    torboxKey: env.torboxKey,
    tmdbKey: env.tmdbKey
  };
}

export function getRuntimeConfig() {
  return runtimeStorage.getStore() || environmentConfig();
}

export function withRuntimeConfig(config, callback) {
  const base = environmentConfig();
  const merged = {
    ...base,
    ...(config || {})
  };
  return runtimeStorage.run(merged, callback);
}

export function skTorrentConfigured(config = getRuntimeConfig()) {
  return Boolean(config?.sktUid && config?.sktPass);
}
