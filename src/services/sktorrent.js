import * as cheerio from 'cheerio';
import parseTorrent from 'parse-torrent';
import { env, skTorrentConfigured } from '../env.js';
import { TtlCache } from '../lib/cache.js';
import { fetchWithTimeout, mapPool } from '../lib/http.js';

const BASE_URL = 'https://sktorrent.eu';
const SEARCH_URL = `${BASE_URL}/torrent/torrents_v2.php`;
const cache = new TtlCache({ ttlMs: env.cacheTtlMs, max: 600 });

function headers() {
  return {
    'user-agent': 'Mozilla/5.0 (compatible; n-sktorrent-streamio-ad/1.0)',
    'accept-language': 'sk,cs;q=0.9,en;q=0.6',
    cookie: `uid=${env.sktUid}; pass=${env.sktPass}`,
    referer: BASE_URL
  };
}

function parseSize(text) {
  const match = String(text).match(/(\d+(?:[.,]\d+)?)\s*(TB|GB|MB|KB)/i);
  return match ? `${match[1].replace(',', '.')} ${match[2].toUpperCase()}` : '?';
}

function parseSeeds(text) {
  const patterns = [/(?:seed(?:ers?)?|seeds?)\s*[:\-]?\s*(\d+)/i, /S\s*[:\-]\s*(\d+)/i];
  for (const pattern of patterns) {
    const match = String(text).match(pattern);
    if (match) return Number(match[1]);
  }
  return 0;
}

function parseSearchHtml(html) {
  const $ = cheerio.load(html);
  const results = [];

  $('a[href^="details.php"], a[href*="/torrent/details.php"]').each((_, node) => {
    const anchor = $(node);
    const href = anchor.attr('href') || '';
    let id = null;
    try {
      id = new URL(href, `${BASE_URL}/torrent/`).searchParams.get('id');
    } catch {
      id = href.match(/[?&]id=(\d+)/)?.[1] || null;
    }
    if (!id) return;

    const cell = anchor.closest('td');
    const row = anchor.closest('tr');
    const context = `${cell.text()} ${row.text()}`.replace(/\s+/g, ' ').trim();
    const image = anchor.find('img').first();
    const name = (anchor.attr('title') || image.attr('alt') || anchor.text() || '').replace(/\s+/g, ' ').trim();
    if (!name) return;

    results.push({
      id,
      name,
      sizeLabel: parseSize(context),
      seeds: parseSeeds(context),
      detailUrl: new URL(href, `${BASE_URL}/torrent/`).toString()
    });
  });

  return results;
}

async function fetchSearchPage(query, page) {
  const url = new URL(SEARCH_URL);
  url.searchParams.set('search', query);
  url.searchParams.set('category', '0');
  url.searchParams.set('active', '0');
  url.searchParams.set('order', 'data');
  url.searchParams.set('by', 'DESC');
  url.searchParams.set('page', String(page));

  const response = await fetchWithTimeout(url, { headers: headers(), redirect: 'follow' });
  if (!response.ok) throw new Error(`SKTorrent search returned HTTP ${response.status}`);
  return parseSearchHtml(await response.text());
}

export async function searchSkTorrent(query, pages) {
  if (!skTorrentConfigured()) throw new Error('SKTorrent credentials are not configured');
  const key = `search:${query}:${pages}`;
  return cache.remember(key, async () => {
    const pageNumbers = Array.from({ length: pages }, (_, index) => index);
    const pageResults = await mapPool(pageNumbers, 3, (page) => fetchSearchPage(query, page));
    const dedupe = new Map();
    for (const result of pageResults) {
      if (!Array.isArray(result)) continue;
      for (const item of result) dedupe.set(item.id, item);
    }
    return [...dedupe.values()];
  });
}

function normalizeTorrentFiles(parsed) {
  if (Array.isArray(parsed.files) && parsed.files.length) {
    return parsed.files.map((file, index) => ({
      index,
      path: file.path || file.name || `file-${index}`,
      name: file.name || file.path || `file-${index}`,
      length: Number(file.length || 0)
    }));
  }

  if (parsed.name) {
    return [{ index: 0, path: parsed.name, name: parsed.name, length: Number(parsed.length || 0) }];
  }
  return [];
}

export async function loadTorrentDescriptor(id) {
  if (!skTorrentConfigured()) throw new Error('SKTorrent credentials are not configured');
  return cache.remember(`torrent:${id}`, async () => {
    const url = `${BASE_URL}/torrent/download.php?id=${encodeURIComponent(id)}`;
    const response = await fetchWithTimeout(url, { headers: headers(), redirect: 'follow' }, 12_000);
    if (!response.ok) throw new Error(`Torrent download returned HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') || '';
    if (/text\/html/i.test(contentType)) throw new Error('SKTorrent returned HTML instead of a torrent; credentials may be invalid');

    const buffer = Buffer.from(await response.arrayBuffer());
    const parsed = await Promise.resolve(parseTorrent(buffer));
    if (!parsed?.infoHash) throw new Error('Could not parse torrent info hash');

    return {
      infoHash: String(parsed.infoHash).toLowerCase(),
      name: parsed.name || '',
      length: Number(parsed.length || 0),
      files: normalizeTorrentFiles(parsed)
    };
  }, 30 * 60_000);
}
