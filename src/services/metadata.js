import { env } from '../env.js';
import { TtlCache } from '../lib/cache.js';
import { getJson } from '../lib/http.js';

const cache = new TtlCache({ ttlMs: 6 * 60 * 60_000, max: 500 });

function addTitle(set, value) {
  if (typeof value === 'string' && value.trim().length > 1) set.add(value.trim());
}

async function getCinemeta(type, imdbId) {
  try {
    const data = await getJson(`https://v3-cinemeta.strem.io/meta/${encodeURIComponent(type)}/${encodeURIComponent(imdbId)}.json`);
    return data?.meta || null;
  } catch {
    return null;
  }
}

async function getTmdbFind(imdbId, language) {
  if (!env.tmdbKey) return null;
  const url = new URL(`https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}`);
  url.searchParams.set('api_key', env.tmdbKey);
  url.searchParams.set('external_source', 'imdb_id');
  url.searchParams.set('language', language);
  try {
    return await getJson(url);
  } catch {
    return null;
  }
}

function tmdbRecord(data, type) {
  if (!data) return null;
  return type === 'series' ? data.tv_results?.[0] : data.movie_results?.[0];
}

export async function resolveMetadata(type, imdbId) {
  return cache.remember(`${type}:${imdbId}`, async () => {
    const [cinemeta, tmdbCs, tmdbSk, tmdbEn] = await Promise.all([
      getCinemeta(type, imdbId),
      getTmdbFind(imdbId, 'cs-CZ'),
      getTmdbFind(imdbId, 'sk-SK'),
      getTmdbFind(imdbId, 'en-US')
    ]);

    const titles = new Set();
    addTitle(titles, cinemeta?.name);

    const records = [tmdbRecord(tmdbCs, type), tmdbRecord(tmdbSk, type), tmdbRecord(tmdbEn, type)].filter(Boolean);
    for (const record of records) {
      addTitle(titles, record.title);
      addTitle(titles, record.original_title);
      addTitle(titles, record.name);
      addTitle(titles, record.original_name);
    }

    const first = records[0];
    const date = first?.release_date || first?.first_air_date || cinemeta?.releaseInfo || '';
    const yearMatch = String(date).match(/\b(?:19|20)\d{2}\b/);

    return {
      imdbId,
      type,
      titles: [...titles],
      primaryTitle: [...titles][0] || imdbId,
      year: yearMatch ? Number(yearMatch[0]) : null
    };
  });
}
