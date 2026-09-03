import { getRuntimeConfig } from '../env.js';
import { TtlCache } from '../lib/cache.js';
import { getJson } from '../lib/http.js';

const cache = new TtlCache({ ttlMs: 6 * 60 * 60_000, max: 500 });

function addTitle(set, value) {
  if (typeof value === 'string' && value.trim().length > 1) set.add(value.trim());
}

function addTitleCollection(set, value) {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item === 'string') addTitle(set, item);
    else {
      addTitle(set, item?.title);
      addTitle(set, item?.name);
    }
  }
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
  const { tmdbKey } = getRuntimeConfig();
  if (!tmdbKey) return null;
  const url = new URL(`https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}`);
  url.searchParams.set('api_key', tmdbKey);
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

function localizedRecordTitle(record, type) {
  if (!record) return null;
  return type === 'series' ? record.name : record.title;
}

function originalRecordTitle(record, type) {
  if (!record) return null;
  return type === 'series' ? record.original_name : record.original_title;
}

async function getTmdbAlternativeTitles(type, tmdbId) {
  const { tmdbKey } = getRuntimeConfig();
  if (!tmdbKey || !tmdbId) return [];

  const kind = type === 'series' ? 'tv' : 'movie';
  const url = new URL(`https://api.themoviedb.org/3/${kind}/${encodeURIComponent(tmdbId)}/alternative_titles`);
  url.searchParams.set('api_key', tmdbKey);

  try {
    const data = await getJson(url);
    const items = type === 'series' ? data?.results : data?.titles;
    if (!Array.isArray(items)) return [];

    // Prefer names relevant to Czech/Slovak users plus common international
    // markets. Keeping the list bounded prevents unrelated aliases from
    // exploding the number of SKTorrent searches.
    const preferredCountries = new Set(['CZ', 'SK', 'US', 'GB', 'CA', 'FR']);
    const preferred = items.filter((item) => preferredCountries.has(String(item?.iso_3166_1 || '').toUpperCase()));
    const rest = items.filter((item) => !preferredCountries.has(String(item?.iso_3166_1 || '').toUpperCase()));
    return [...preferred, ...rest].slice(0, 12);
  } catch {
    return [];
  }
}

export async function resolveMetadata(type, imdbId) {
  const { tmdbKey } = getRuntimeConfig();
  return cache.remember(`${tmdbKey ? 'tmdb' : 'cinemeta'}:${type}:${imdbId}`, async () => {
    const [cinemeta, tmdbCs, tmdbSk, tmdbEn] = await Promise.all([
      getCinemeta(type, imdbId),
      getTmdbFind(imdbId, 'cs-CZ'),
      getTmdbFind(imdbId, 'sk-SK'),
      getTmdbFind(imdbId, 'en-US')
    ]);

    const csRecord = tmdbRecord(tmdbCs, type);
    const skRecord = tmdbRecord(tmdbSk, type);
    const enRecord = tmdbRecord(tmdbEn, type);

    const titles = new Set();
    addTitle(titles, cinemeta?.name);
    addTitle(titles, cinemeta?.originalName);
    addTitle(titles, cinemeta?.original_title);
    addTitleCollection(titles, cinemeta?.aliases);
    addTitleCollection(titles, cinemeta?.alternativeTitles);

    const records = [csRecord, skRecord, enRecord].filter(Boolean);
    for (const record of records) {
      addTitle(titles, record.title);
      addTitle(titles, record.original_title);
      addTitle(titles, record.name);
      addTitle(titles, record.original_name);
    }

    const tmdbId = records.find((record) => record?.id)?.id;
    const alternativeTitles = await getTmdbAlternativeTitles(type, tmdbId);
    addTitleCollection(titles, alternativeTitles);

    const first = records[0];
    const date = first?.release_date || first?.first_air_date || cinemeta?.releaseInfo || '';
    const yearMatch = String(date).match(/\b(?:19|20)\d{2}\b/);

    const primaryTitle = [...titles][0] || imdbId;
    const titleCz = localizedRecordTitle(csRecord, type)
      || localizedRecordTitle(skRecord, type)
      || cinemeta?.name
      || primaryTitle;
    const titleOriginal = originalRecordTitle(enRecord, type)
      || originalRecordTitle(csRecord, type)
      || cinemeta?.originalName
      || cinemeta?.original_title
      || primaryTitle;

    return {
      imdbId,
      type,
      titles: [...titles],
      primaryTitle,
      titleCz,
      titleOriginal,
      year: yearMatch ? Number(yearMatch[0]) : null
    };
  });
}
