import { env } from '../env.js';
import { mapPool } from '../lib/http.js';
import {
  chooseVideoFile,
  extractReleaseTraits,
  normalize,
  releaseMatchesTitle
} from '../domain/media.js';
import { formatStreamDisplay } from '../domain/stream-display.js';
import { resolveMetadata } from './metadata.js';
import { loadTorrentDescriptor, searchSkTorrent } from './sktorrent.js';
import { checkCached, checkDownloading } from './torbox.js';

function makeQueries(meta, type, season) {
  const queries = new Set();
  const titles = meta.titles.slice(0, 6);

  for (const title of titles) {
    const raw = String(title || '').trim();
    const normalized = normalize(raw);
    if (!raw || !normalized) continue;

    queries.add(raw);
    if (normalized !== raw.toLowerCase()) queries.add(normalized);

    if (type === 'movie' && meta.year) {
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

function makeOlderFirstQueries(meta) {
  const queries = new Set();
  for (const title of meta.titles.slice(0, 8)) {
    const normalized = normalize(title);
    if (normalized.length >= 4) queries.add(normalized);
    if (queries.size >= 4) break;
  }
  return [...queries];
}

function scoreSearchResult(item, meta) {
  const titleBonus = releaseMatchesTitle(item.name, meta.titles, meta.year) ? 100 : 0;
  return titleBonus + Math.min(Number(item.seeds || 0), 50);
}

function mergeSearchGroups(dedupe, groups, meta) {
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const item of group) {
      const old = dedupe.get(item.id);
      if (!old || scoreSearchResult(item, meta) > scoreSearchResult(old, meta)) dedupe.set(item.id, item);
    }
  }
}

function matchingSearchResults(dedupe, meta) {
  return [...dedupe.values()]
    .filter((item) => releaseMatchesTitle(item.name, meta.titles, meta.year))
    .sort((a, b) => scoreSearchResult(b, meta) - scoreSearchResult(a, meta))
    .slice(0, env.maxTorrentsToInspect);
}

async function searchAll(meta, type, season) {
  const pages = type === 'series' ? env.seriesSearchPages : env.movieSearchPages;
  const queries = makeQueries(meta, type, season);
  const groups = await mapPool(queries, 2, (query) => searchSkTorrent(query, pages));
  const dedupe = new Map();
  mergeSearchGroups(dedupe, groups, meta);

  let matched = matchingSearchResults(dedupe, meta);
  let olderFirstUsed = false;

  if (type === 'movie' && meta.year && matched.length === 0) {
    const olderQueries = makeOlderFirstQueries(meta);
    if (olderQueries.length) {
      olderFirstUsed = true;
      const olderPages = Math.min(Math.max(pages, 4), 8);
      const olderGroups = await mapPool(
        olderQueries,
        2,
        (query) => searchSkTorrent(query, olderPages, { direction: 'ASC' })
      );
      mergeSearchGroups(dedupe, olderGroups, meta);
      matched = matchingSearchResults(dedupe, meta);
    }
  }

  console.log(`[search] ${type} ${meta.imdbId} aliases=${meta.titles.length} queries=${queries.length} olderFirst=${olderFirstUsed} found=${dedupe.size} matched=${matched.length}`);
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

function basename(path = '') {
  return String(path).split(/[\\/]/).pop() || 'video.mkv';
}

function torboxProxyUrl(candidate, cached, context) {
  const base = String(context.torboxStartBaseUrl || '').replace(/\/+$/, '');
  if (!base) return null;

  if (!cached) {
    return `${base}/download/${encodeURIComponent(candidate.infoHash)}/${encodeURIComponent(candidate.searchItem.id)}`;
  }

  const season = context.season || 0;
  const episode = context.episode || 0;
  const safeName = basename(candidate.file?.path || candidate.file?.name).replaceAll('/', '|');
  return `${base}/play/${encodeURIComponent(candidate.infoHash)}/${season}/${episode}/${encodeURIComponent(safeName)}`;
}

function stremioStream(candidate, cached, downloading, context) {
  const { name, title } = formatStreamDisplay(candidate, {
    cached: Boolean(cached),
    downloading: Boolean(downloading),
    type: context.type,
    season: context.season,
    episode: context.episode
  });

  const proxyUrl = torboxProxyUrl(candidate, cached, context);
  if (proxyUrl) {
    return {
      name,
      title,
      url: proxyUrl,
      behaviorHints: {
        bingeGroup: `n-skt-${candidate.quality.toLowerCase().replace(/\W+/g, '-')}`
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

export async function buildStreams({ type, imdbId, season, episode, torboxStartBaseUrl = '' }) {
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

  const hashes = candidates.map((item) => item.infoHash);
  const [cacheMap, downloadingMap] = await Promise.all([
    checkCached(hashes),
    checkDownloading(hashes)
  ]);
  candidates.sort((a, b) => compareCandidates(a, b, cacheMap));

  return candidates.map((candidate) => stremioStream(
    candidate,
    cacheMap.get(candidate.infoHash),
    downloadingMap.get(candidate.infoHash),
    { type, season, episode, torboxStartBaseUrl }
  ));
}
