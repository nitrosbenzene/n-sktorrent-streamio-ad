import { readFileSync } from 'node:fs';
import app from './app.js';
import { decryptConfig } from './config-token.js';
import { getRuntimeConfig, skTorrentConfigured, withRuntimeConfig } from './env.js';
import { fetchWithTimeout } from './lib/http.js';

const SKTORRENT_BASE = 'https://sktorrent.eu';
const TORBOX_API = 'https://api.torbox.app/v1/api/torrents';
const infoVideo = readFileSync(new URL('./assets/torbox-downloading.mp4', import.meta.url));

function plain(res, status, text) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.end(text);
}

function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  return res.end();
}

function sendInfoVideo(req, res) {
  const total = infoVideo.length;
  const range = String(req.headers.range || '').trim();
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');

  if (!range) {
    res.statusCode = 200;
    res.setHeader('Content-Length', String(total));
    return req.method === 'HEAD' ? res.end() : res.end(infoVideo);
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    res.statusCode = 416;
    res.setHeader('Content-Range', `bytes */${total}`);
    return res.end();
  }

  let start;
  let end;
  if (!match[1] && match[2]) {
    const suffix = Number(match[2]);
    start = Math.max(total - suffix, 0);
    end = total - 1;
  } else {
    start = match[1] ? Number(match[1]) : 0;
    end = match[2] ? Number(match[2]) : total - 1;
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= total || end < start) {
    res.statusCode = 416;
    res.setHeader('Content-Range', `bytes */${total}`);
    return res.end();
  }

  end = Math.min(end, total - 1);
  res.statusCode = 206;
  res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
  res.setHeader('Content-Length', String(end - start + 1));
  return req.method === 'HEAD' ? res.end() : res.end(infoVideo.subarray(start, end + 1));
}

function skTorrentHeaders() {
  const config = getRuntimeConfig();
  return {
    'user-agent': 'Mozilla/5.0 (compatible; n-sktorrent-streamio-ad/1.0)',
    'accept-language': 'sk,cs;q=0.9,en;q=0.6',
    cookie: `uid=${config.sktUid}; pass=${config.sktPass}`,
    referer: SKTORRENT_BASE
  };
}

async function downloadRawTorrent(sktId) {
  if (!skTorrentConfigured()) throw new Error('SKTorrent credentials are not configured');
  if (!/^\d+$/.test(String(sktId || ''))) throw new Error('Invalid SKTorrent torrent id');

  const url = `${SKTORRENT_BASE}/torrent/download.php?id=${encodeURIComponent(sktId)}`;
  const response = await fetchWithTimeout(url, {
    headers: skTorrentHeaders(),
    redirect: 'follow'
  }, 15_000);
  if (!response.ok) throw new Error(`SKTorrent torrent download returned HTTP ${response.status}`);

  const contentType = response.headers.get('content-type') || '';
  if (/text\/html/i.test(contentType)) throw new Error('SKTorrent returned HTML instead of a torrent file');
  const buffer = Buffer.from(await response.arrayBuffer());
  const head = buffer.subarray(0, 80).toString('utf8').toLowerCase();
  if (!buffer.length || head.includes('<html') || head.includes('<!doc')) {
    throw new Error('SKTorrent did not return a torrent file');
  }
  return buffer;
}

function torboxHeaders(extra = {}) {
  return { Authorization: `Bearer ${getRuntimeConfig().torboxKey || ''}`, ...extra };
}

function unwrap(payload) {
  return payload?.data ?? payload;
}

async function torboxJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.success === false) {
    throw new Error(payload?.detail || payload?.error || `TorBox HTTP ${response.status}`);
  }
  return payload;
}

function torrentList(payload) {
  const data = unwrap(payload);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.torrents)) return data.torrents;
  if (data && typeof data === 'object') return [data];
  return [];
}

function torrentHash(item) {
  return String(item?.hash || item?.info_hash || '').toLowerCase();
}

async function fetchTorrentList(id = null) {
  const url = new URL(`${TORBOX_API}/mylist`);
  url.searchParams.set('bypass_cache', 'true');
  if (id != null) url.searchParams.set('id', String(id));
  return torrentList(await torboxJson(await fetchWithTimeout(url, { headers: torboxHeaders() }, 10_000)));
}

async function createMagnetTorrent(hash) {
  const form = new FormData();
  form.append('magnet', `magnet:?xt=urn:btih:${hash}`);
  form.append('seed', '1');
  const payload = await torboxJson(await fetchWithTimeout(`${TORBOX_API}/createtorrent`, {
    method: 'POST',
    headers: torboxHeaders(),
    body: form
  }, 15_000));
  const data = unwrap(payload);
  return data?.torrent_id ?? data?.id ?? null;
}

async function uploadTorrentFile(buffer, hash) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'application/x-bittorrent' }), `${hash}.torrent`);
  return torboxJson(await fetchWithTimeout(`${TORBOX_API}/createtorrent`, {
    method: 'POST',
    headers: torboxHeaders(),
    body: form
  }, 15_000));
}

async function waitForTorrentFiles(torrentId, maxAttempts = 15, intervalMs = 1500) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const list = await fetchTorrentList(torrentId);
    const item = list.find((entry) => String(entry?.id) === String(torrentId)) || list[0];
    if (item?.files?.length) return item;
  }
  return null;
}

function videoFiles(files) {
  return (Array.isArray(files) ? files : []).filter((file) =>
    /\.(mp4|mkv|avi|m4v)$/i.test(String(file?.name || file?.short_name || ''))
  );
}

function cleanName(value) {
  return String(value || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function chooseFile(files, fileName, season, episode) {
  const videos = videoFiles(files);
  if (!videos.length) return null;

  let selected = null;
  if (fileName && fileName !== 'undefined') {
    const wanted = cleanName(fileName);
    selected = videos.find((file) => {
      const actual = cleanName(file?.name || file?.short_name || '');
      return actual && wanted && (actual.includes(wanted) || wanted.includes(actual));
    });
  }

  const seasonNum = Number.parseInt(season, 10);
  const episodeNum = Number.parseInt(episode, 10);
  if (!selected && Number.isInteger(seasonNum) && seasonNum > 0 && Number.isInteger(episodeNum) && episodeNum > 0) {
    const epStr = String(episodeNum).padStart(2, '0');
    const seasonStr = String(seasonNum).padStart(2, '0');
    const regexes = [
      new RegExp(`S${seasonStr}[._-]?E${epStr}\\b`, 'i'),
      new RegExp(`\\b${seasonNum}x${epStr}\\b`, 'i'),
      new RegExp(`\\b${seasonNum}x0*${episodeNum}\\b`, 'i'),
      new RegExp(`S${seasonStr}[._-]?E${epStr}(?![0-9])`, 'i'),
      new RegExp(`Ep(?:isode)?[._\\s]*0*${episodeNum}\\b`, 'i'),
      new RegExp(`\\b0*${episodeNum}[._\\s-]*(?:Epiz[oó]da|Diel|Časť|Cast)\\b`, 'i'),
      new RegExp(`\\bE${epStr}\\b`, 'i')
    ];
    for (const regex of regexes) {
      selected = videos.find((file) => regex.test(String(file?.name || file?.short_name || '')));
      if (selected) break;
    }
  }

  if (selected) return selected;
  if (!Number.isInteger(seasonNum) || seasonNum <= 0) {
    return [...videos].sort((a, b) => Number(b?.size || 0) - Number(a?.size || 0))[0];
  }
  return null;
}

async function requestDownloadUrl(torrentId, fileId) {
  const key = getRuntimeConfig().torboxKey || '';
  const url = new URL(`${TORBOX_API}/requestdl`);
  url.searchParams.set('token', key);
  url.searchParams.set('torrent_id', String(torrentId));
  url.searchParams.set('file_id', String(fileId));
  const payload = await torboxJson(await fetchWithTimeout(url, { headers: torboxHeaders() }, 10_000));
  const data = unwrap(payload);
  return typeof data === 'string' ? data : data?.link || data?.url || null;
}

async function handleDownload(req, res, { hash, sktId }) {
  const config = getRuntimeConfig();
  if (!config.torboxKey) return plain(res, 400, 'Chýba TorBox API kľúč.');
  if (!/^[a-f0-9]{40,64}$/i.test(hash)) return plain(res, 400, 'Neplatný torrent hash.');

  try {
    const torrentBuffer = await downloadRawTorrent(sktId);
    await uploadTorrentFile(torrentBuffer, hash.toLowerCase());
    console.log(`[torbox] uploaded SKTorrent .torrent id=${sktId} hash=${hash.toLowerCase()}`);
    return redirect(res, '/info-video');
  } catch (error) {
    console.error('[torbox] .torrent upload failed:', error);
    return plain(res, 500, 'Chyba API stahovania TorBox.');
  }
}

async function handlePlay(req, res, { hash, season, episode, fileName }) {
  const config = getRuntimeConfig();
  if (!config.torboxKey) return plain(res, 400, 'Chýba TorBox API kľúč.');
  if (!/^[a-f0-9]{40,64}$/i.test(hash)) return plain(res, 400, 'Neplatný torrent hash.');

  try {
    const normalized = hash.toLowerCase();
    let torrent = (await fetchTorrentList()).find((item) => torrentHash(item) === normalized);
    let torrentId = torrent?.id;

    if (torrentId == null) {
      torrentId = await createMagnetTorrent(normalized);
      if (torrentId == null) return plain(res, 500, 'TorBox nevytvoril torrent.');
    }

    if (!torrent?.files?.length) torrent = await waitForTorrentFiles(torrentId);
    if (!torrent) {
      return plain(res, 202, 'Torrent sa ešte spracováva na TorBoxe. Skús o 20-30 sekúnd znova (obnov stream v Stremiu).');
    }

    const file = chooseFile(torrent.files, fileName, season, episode);
    if (!file) {
      return plain(res, 404, `V torrente sa nenašiel správny video súbor pre S${season}E${episode}.`);
    }

    const finalUrl = await requestDownloadUrl(torrentId, file.id);
    if (!finalUrl) return plain(res, 500, 'Nepodarilo sa získať streamovací link.');
    return redirect(res, finalUrl);
  } catch (error) {
    console.error('[torbox] play route failed:', error);
    return plain(res, 500, 'Interná chyba pri spracovaní streamu.');
  }
}

function parseProxyPath(req) {
  const pathname = new URL(String(req.url || '/'), 'http://localhost').pathname;
  const raw = pathname.split('/').filter(Boolean);
  let index = 0;
  let token = null;
  if (raw[0] === 'c' && raw[1]) {
    token = decodeURIComponent(raw[1]);
    index = 2;
  }

  const action = raw[index];
  if (action === 'download' && raw[index + 1] && raw[index + 2] && raw.length === index + 3) {
    return {
      token,
      action,
      hash: decodeURIComponent(raw[index + 1]),
      sktId: decodeURIComponent(raw[index + 2])
    };
  }

  if (action === 'play' && raw[index + 1] && raw[index + 2] && raw[index + 3] && raw[index + 4] && raw.length === index + 5) {
    return {
      token,
      action,
      hash: decodeURIComponent(raw[index + 1]),
      season: decodeURIComponent(raw[index + 2]),
      episode: decodeURIComponent(raw[index + 3]),
      fileName: decodeURIComponent(raw[index + 4]).replaceAll('|', '/')
    };
  }
  return null;
}

async function runConfigured(token, callback) {
  if (!token) return callback();
  try {
    const config = decryptConfig(token);
    return withRuntimeConfig(config, callback);
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  const pathname = new URL(String(req.url || '/'), 'http://localhost').pathname;
  if (pathname === '/info-video') return sendInfoVideo(req, res);

  const proxy = parseProxyPath(req);
  if (proxy && (req.method === 'GET' || req.method === 'HEAD')) {
    if (proxy.token) {
      let handled = false;
      const result = await runConfigured(proxy.token, async () => {
        handled = true;
        return proxy.action === 'download'
          ? handleDownload(req, res, proxy)
          : handlePlay(req, res, proxy);
      });
      if (!handled || result === null) return plain(res, 400, 'Invalid addon configuration');
      return result;
    }
    return proxy.action === 'download'
      ? handleDownload(req, res, proxy)
      : handlePlay(req, res, proxy);
  }

  if (/\/stream\//.test(pathname)) res.setHeader('Cache-Control', 'no-store');
  return app(req, res);
}
