import crypto from 'node:crypto';
import { env, getRuntimeConfig } from '../env.js';
import { TtlCache } from '../lib/cache.js';
import { fetchWithTimeout, mapPool } from '../lib/http.js';

const API = 'https://api.torbox.app/v1/api/torrents';
const listCache = new TtlCache({ ttlMs: 5_000, max: 20 });

function torboxKey() {
  return getRuntimeConfig().torboxKey || '';
}

function keyFingerprint(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${torboxKey()}`, ...extra };
}

function unwrap(payload) {
  return payload?.data ?? payload;
}

async function json(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.success === false) {
    throw new Error(payload?.detail || payload?.error || `TorBox HTTP ${response.status}`);
  }
  return payload;
}

function cacheMapFromPayload(payload) {
  const data = unwrap(payload);
  const map = new Map();

  if (Array.isArray(data)) {
    for (const entry of data) {
      if (typeof entry === 'string') {
        map.set(entry.toLowerCase(), true);
        continue;
      }
      const hash = entry?.hash || entry?.info_hash;
      if (hash) map.set(String(hash).toLowerCase(), true);
    }
    return map;
  }

  if (data && typeof data === 'object') {
    for (const [responseHash, value] of Object.entries(data)) {
      const hash = String(value?.hash || value?.info_hash || responseHash).toLowerCase();
      if (!hash) continue;

      // TorBox only includes cached hashes in the object response. A returned
      // object/string/array therefore means the hash is cached even when a
      // dedicated `cached` property is absent.
      const cached = value !== null && value !== false;
      if (cached) map.set(hash, true);
    }
  }

  return map;
}

export async function checkCached(hashes) {
  const key = torboxKey();
  const unique = [...new Set(hashes.filter(Boolean).map((hash) => hash.toLowerCase()))];
  const result = new Map(unique.map((hash) => [hash, false]));
  if (!key || !unique.length) return result;

  for (let offset = 0; offset < unique.length; offset += 50) {
    const chunk = unique.slice(offset, offset + 50);
    const url = new URL(`${API}/checkcached`);
    url.searchParams.set('hash', chunk.join(','));
    url.searchParams.set('format', 'object');
    url.searchParams.set('list_files', 'false');

    try {
      const payload = await json(await fetchWithTimeout(url, { headers: authHeaders() }));
      const mapped = cacheMapFromPayload(payload);
      for (const hash of chunk) {
        if (mapped.get(hash)) result.set(hash, true);
      }
    } catch (error) {
      console.warn('[torbox] cache check failed:', error.message);
    }
  }

  return result;
}

function torrentList(payload) {
  const data = unwrap(payload);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.torrents)) return data.torrents;
  return [];
}

async function fetchTorrentList(id = null) {
  const url = new URL(`${API}/mylist`);
  url.searchParams.set('bypass_cache', 'true');
  if (id != null) url.searchParams.set('id', String(id));
  return torrentList(await json(await fetchWithTimeout(url, { headers: authHeaders() }, 10_000)));
}

async function listTorrents() {
  const key = torboxKey();
  return listCache.remember(`all:${keyFingerprint(key)}`, () => fetchTorrentList(), 5_000);
}

function torrentHash(item) {
  return String(item?.hash || item?.info_hash || '').toLowerCase();
}

export function isTorBoxDownloading(item) {
  if (!item || item.download_finished === true) return false;

  const state = String(item.download_state || item.status || '').trim().toLowerCase();
  const inactiveStates = new Set([
    'paused',
    'failed',
    'failed (processing)',
    'expired',
    'incomplete'
  ]);
  if (inactiveStates.has(state)) return false;

  const downloadingStates = new Set([
    'downloading',
    'stalled (no seeds)',
    'metadl',
    'checkingresumedata',
    'queued'
  ]);
  if (downloadingStates.has(state)) return true;

  return item.active === true;
}

export async function checkDownloading(hashes) {
  const key = torboxKey();
  const unique = [...new Set(hashes.filter(Boolean).map((hash) => hash.toLowerCase()))];
  const result = new Map(unique.map((hash) => [hash, false]));
  if (!key || !unique.length) return result;

  try {
    for (const item of await listTorrents()) {
      const hash = torrentHash(item);
      if (result.has(hash) && isTorBoxDownloading(item)) result.set(hash, true);
    }
  } catch (error) {
    console.warn('[torbox] torrent state check failed:', error.message);
  }

  return result;
}

async function createTorrent(hash) {
  const body = new FormData();
  body.append('magnet', `magnet:?xt=urn:btih:${hash}`);
  body.append('seed', '1');
  const payload = await json(await fetchWithTimeout(`${API}/createtorrent`, {
    method: 'POST', headers: authHeaders(), body
  }, 12_000));
  const data = unwrap(payload);
  return data?.torrent_id ?? data?.id ?? data;
}

async function findOrCreateTorrent(hash) {
  const existing = (await listTorrents()).find((item) => torrentHash(item) === hash.toLowerCase());
  if (existing) return existing;

  const id = await createTorrent(hash);
  if (id == null) throw new Error('TorBox did not return a torrent id');

  for (let attempt = 0; attempt < 3; attempt++) {
    const list = await fetchTorrentList(id);
    const item = list.find((entry) => String(entry?.id) === String(id) || torrentHash(entry) === hash.toLowerCase());
    if (item?.files?.length) return item;
    await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
  }
  return { id, files: [] };
}

function chooseTorBoxFile(files, wanted) {
  if (!Array.isArray(files) || !files.length) return null;
  const wantedName = String(wanted?.path || wanted?.name || '').split('/').pop()?.toLowerCase();
  if (wantedName) {
    const exact = files.find((file) => String(file?.name || file?.short_name || '').split('/').pop()?.toLowerCase() === wantedName);
    if (exact) return exact;
  }
  if (Number.isInteger(wanted?.index) && files[wanted.index]) return files[wanted.index];
  return files.slice().sort((a, b) => Number(b?.size || 0) - Number(a?.size || 0))[0];
}

export async function makeDirectLink(hash, wantedFile) {
  const key = torboxKey();
  if (!key) return null;
  const torrent = await findOrCreateTorrent(hash);
  const file = chooseTorBoxFile(torrent.files, wantedFile);
  if (!file) return null;

  const url = new URL(`${API}/requestdl`);
  url.searchParams.set('token', key);
  url.searchParams.set('torrent_id', String(torrent.id));
  url.searchParams.set('file_id', String(file.id));
  const payload = await json(await fetchWithTimeout(url, { headers: authHeaders() }, 10_000));
  const data = unwrap(payload);
  return typeof data === 'string' ? data : data?.link || data?.url || null;
}

export async function attachDirectLinks(candidates, cacheMap) {
  if (!torboxKey() || !env.torboxDirectLinks || env.torboxMaxDirectLinks <= 0) return candidates;
  const eligible = candidates.filter((item) => cacheMap.get(item.infoHash)).slice(0, env.torboxMaxDirectLinks);
  const results = await mapPool(eligible, 2, async (item) => ({ item, url: await makeDirectLink(item.infoHash, item.file) }));
  const urls = new Map();
  for (const result of results) {
    if (result?.item && result.url) urls.set(result.item.infoHash + ':' + result.item.file.index, result.url);
  }
  return candidates.map((item) => ({ ...item, directUrl: urls.get(item.infoHash + ':' + item.file.index) || null }));
}
