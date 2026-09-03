import { env } from '../env.js';
import { mapPool } from '../lib/http.js';
import {
  chooseVideoFile,
  extractReleaseTraits,
  formatBytes,
  normalize,
  releaseMatchesTitle
} from '../domain/media.js';
import { resolveMetadata } from './metadata.js';
import { loadTorrentDescriptor, searchSkTorrent } from './sktorrent.js';
import { attachDirectLinks, checkCached } from './torbox.js';

function makeQueries(meta, type, season) {
  const queries = new Set();
  const titles = meta.titles.slice(0, 6);

  for (const title of titles) {
    const raw = String(title || '').trim();
    const normalized = normalize(raw);
    if (!raw || !normalized) continue;

    // Search both the displayed/original spelling and an accent/punctuation-free
    // spelling. Examples: WALL·E -> "wall e", Balerína -> "balerina".
    queries.add(raw);
    if (normalized !== raw.toLowerCase()) queries.add(normalized);

    if (type === 'movie' && meta.year) {
      // A year-qualified query is most useful for short/generic titles. Keep it
      // bounded so we do not multiply SKTorrent page requests unnecessarily.
      const tokenCount = normalized.split(' ').length;
      if (normalized.length <= 12 || tokenCount <= 2) queries.add(`${normalized} ${meta.year}`);
    }

    if (type === 'series' && season != null) {
      queries.add(`${normalized} S${String(season).padStart(2, '0')}`);
      queries.add(`${normalized} ${season}. serie`);
    }
  }

  return [...queries].slice(0, type === 'movie' ? 8 : 10);
}

function scoreSearchResult(item, meta) {
  const titleBonus = releaseMatchesTitle(item.name, meta.titles, meta.year) ? 100 : 0;
  return titleBonus + Math.min(Number(item.seeds || 0), 50);
}

async function searchAll(meta, type, season) {
  const pages = type === 'series' ? env.seriesSearchPages : env.movieSearchPages;
  const queries = makeQueries(meta, type, season);
  const groups = await mapPool(queries, 2, (query) => searchSkTorrent(query, pages));
  const dedupe = new Map();
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const item of group) {
      const old = dedupe.get(item.id);
      if (!old || scoreSearchResult(item, meta) > scoreSearchResult(old, meta)) dedupe.set(item.id, item);
    }
  }

  const matched = [...dedupe.values()]
    .filter((item) => releaseMatchesTitle(item.name, meta.titles, meta.year))
    .sort((a, b) => scoreSearchResult(b, meta) - scoreSearchResult(a, meta))
    .slice(0, env.maxTorrentsToInspect);

  console.log(`[search] ${type} ${meta.imdbId} aliases=${meta.titles.length} queries=${queries.length} found=${dedupe.size} matched=${matched.length}`);
  return matched;
}

function candidateFromTorrent(searchItem, torrent, file, meta) {
  const traits = extractReleaseTraits(`${searchItem.name} ${file.path}`);
  return {
    searchItem,
    torrent,
    file,
    infoHash: torrent.infoHash,
    title: searchItem.name,
    quality: traits.quality,
    traits,
    meta
  };
}

function qualityRank(quality) {
  switch (quality) {
    case '4K': return 4;
    case '1080p': return 3;
    case '720p': return 2;
    case 'SD': return 1;
    default: return 0;
  }
}

function compareCandidates(a, b, cacheMap) {
  const cachedDiff = Number(Boolean(cacheMap.get(b.infoHash))) - Number(Boolean(cacheMap.get(a.infoHash)));
  if (cachedDiff) return cachedDiff;

  const qualityDiff = qualityRank(b.quality) - qualityRank(a.quality);
  if (qualityDiff) return qualityDiff;

  const sizeDiff = Number(b.file?.length || 0) - Number(a.file?.length || 0);
  if (sizeDiff) return sizeDiff;

  return Number(b.searchItem?.seeds || 0) - Number(a.searchItem?.seeds || 0);
}

function stremioStream(candidate, cached) {
  const isCached = Boolean(cached);
  const tags = [candidate.quality, ...candidate.traits.flags, ...candidate.traits.languages].filter(Boolean);
  const fileSize = formatBytes(candidate.file.length);
  const torrentSize = formatBytes(candidate.torrent.length);
  const sourceLabel = isCached ? '⚡ TORBOX CACHED' : 'P2P';
  const qualityLabel = tags.join(' · ') || 'Torrent';

  const name = isCached
    ? `⚡ TORBOX · ${qualityLabel}`
    : `N-SKT · ${qualityLabel} · P2P`;

  const title = [
    `${sourceLabel} · ${candidate.title}`,
    `📦 ${fileSize}${torrentSize !== '?' && torrentSize !== fileSize ? ` / ${torrentSize}` : ''}`,
    candidate.file.path
  ].join('\n');

  if (candidate.directUrl) {
    return {
      name,
      title,
      url: candidate.directUrl,
      behaviorHints: {
        bingeGroup: `n-skt-${candidate.quality.toLowerCase().replace(/\W+/g, '-')}`,
        notWebReady: false
      }
    };
  }

  return {
    name,
    title,
    infoHash: candidate.infoHash,
    fileIdx: candidate.file.index,
    behaviorHints: {
      bingeGroup: `n-skt-${candidate.quality.toLowerCase().replace(/\W+/g, '-')}`
    }
  };
}

export async function buildStreams({ type, imdbId, season, episode }) {
  const meta = await resolveMetadata(type, imdbId);
  if (!meta.titles.length) return [];

  const searchResults = await searchAll(meta, type, season);
  const inspected = await mapPool(searchResults, env.torrentFetchConcurrency, async (item) => {
    const torrent = await loadTorrentDescriptor(item.id);
    const file = chooseVideoFile(torrent.files, { season, episode });
    if (!file) return null;
    return candidateFromTorrent(item, torrent, file, meta);
  });

  let candidates = inspected.filter((item) => item && !item.__error);
  const seen = new Set();
  candidates = candidates.filter((candidate) => {
    const key = `${candidate.infoHash}:${candidate.file.index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const cacheMap = await checkCached(candidates.map((item) => item.infoHash));
  candidates.sort((a, b) => compareCandidates(a, b, cacheMap));
  candidates = await attachDirectLinks(candidates, cacheMap);

  return candidates.map((candidate) => stremioStream(candidate, cacheMap.get(candidate.infoHash)));
}
