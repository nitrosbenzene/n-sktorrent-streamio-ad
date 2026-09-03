import { env } from '../env.js';
import { mapPool } from '../lib/http.js';
import {
  chooseVideoFile,
  extractReleaseTraits,
  formatBytes,
  releaseMatchesTitle
} from '../domain/media.js';
import { resolveMetadata } from './metadata.js';
import { loadTorrentDescriptor, searchSkTorrent } from './sktorrent.js';
import { attachDirectLinks, checkCached } from './torbox.js';

function makeQueries(meta, type, season) {
  const queries = new Set();
  for (const title of meta.titles.slice(0, 4)) {
    queries.add(title);
    if (type === 'movie' && meta.year) queries.add(`${title} ${meta.year}`);
    if (type === 'series' && season != null) {
      queries.add(`${title} S${String(season).padStart(2, '0')}`);
      queries.add(`${title} ${season}. serie`);
    }
  }
  return [...queries].slice(0, type === 'movie' ? 6 : 8);
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
  return [...dedupe.values()]
    .filter((item) => releaseMatchesTitle(item.name, meta.titles, meta.year))
    .sort((a, b) => scoreSearchResult(b, meta) - scoreSearchResult(a, meta))
    .slice(0, env.maxTorrentsToInspect);
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

function stremioStream(candidate, cached) {
  const tags = [candidate.quality, ...candidate.traits.flags, ...candidate.traits.languages].filter(Boolean);
  const fileSize = formatBytes(candidate.file.length);
  const torrentSize = formatBytes(candidate.torrent.length);
  const cachedLabel = cached ? '⚡ TorBox cached' : 'P2P';
  const label = `${tags.join(' · ') || 'Torrent'} · ${cachedLabel}`;
  const title = [
    candidate.title,
    `📦 ${fileSize}${torrentSize !== '?' && torrentSize !== fileSize ? ` / ${torrentSize}` : ''}`,
    candidate.file.path
  ].join('\n');

  if (candidate.directUrl) {
    return {
      name: `N-SKT · ${label}`,
      title,
      url: candidate.directUrl,
      behaviorHints: {
        bingeGroup: `n-skt-${candidate.quality.toLowerCase().replace(/\W+/g, '-')}`,
        notWebReady: false
      }
    };
  }

  return {
    name: `N-SKT · ${label}`,
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
  candidates.sort((a, b) => Number(cacheMap.get(b.infoHash)) - Number(cacheMap.get(a.infoHash)) || Number(b.searchItem.seeds) - Number(a.searchItem.seeds));
  candidates = await attachDirectLinks(candidates, cacheMap);

  return candidates.map((candidate) => stremioStream(candidate, cacheMap.get(candidate.infoHash)));
}
