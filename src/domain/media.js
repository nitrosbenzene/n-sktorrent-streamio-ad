const VIDEO_EXTENSIONS = new Set(['mkv', 'mp4', 'avi', 'm4v', 'mov', 'ts', 'm2ts', 'webm', 'wmv']);

export function stripDiacritics(value = '') {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function normalize(value = '') {
  return stripDiacritics(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[._\-()[\]{}:;,!?+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenizeTitle(value = '') {
  const ignored = new Set(['the', 'a', 'an', 'and', 'of', 'in', 'na', 'a', 'i', 's', 'z']);
  return normalize(value)
    .split(' ')
    .filter((token) => token.length > 1 && !ignored.has(token) && !/^\d{4}$/.test(token));
}

export function titleSimilarity(releaseName, candidate) {
  const release = new Set(tokenizeTitle(releaseName));
  const target = new Set(tokenizeTitle(candidate));
  if (!target.size) return 0;
  let common = 0;
  for (const token of target) if (release.has(token)) common++;
  return common / target.size;
}

export function releaseMatchesTitle(releaseName, titles, year) {
  const similarity = Math.max(0, ...titles.map((title) => titleSimilarity(releaseName, title)));
  if (similarity < 0.6) return false;

  if (year) {
    const years = [...String(releaseName).matchAll(/\b(?:19|20)\d{2}\b/g)].map((m) => Number(m[0]));
    if (years.length && !years.some((value) => Math.abs(value - year) <= 1)) return false;
  }
  return true;
}

export function isVideoFile(path = '') {
  const extension = String(path).split('.').pop()?.toLowerCase();
  return VIDEO_EXTENSIONS.has(extension);
}

export function isJunkVideo(path = '') {
  return /(^|[\/ ._-])(sample|trailer|preview|bonus|extra|featurette)([\/ ._-]|$)/i.test(path);
}

export function parseStremioId(rawId) {
  const [imdbId, seasonRaw, episodeRaw] = String(rawId).split(':');
  return {
    imdbId,
    season: seasonRaw == null ? null : Number.parseInt(seasonRaw, 10),
    episode: episodeRaw == null ? null : Number.parseInt(episodeRaw, 10)
  };
}

export function extractReleaseTraits(name = '') {
  const text = String(name);
  const upper = stripDiacritics(text).toUpperCase();
  const quality = /(?:2160P|4K|UHD)/i.test(text)
    ? '4K'
    : /1080P/i.test(text)
      ? '1080p'
      : /720P/i.test(text)
        ? '720p'
        : /(?:576P|DVD)/i.test(text)
          ? 'SD'
          : 'Unknown';

  const flags = [];
  if (/\b(?:DV|DOVI|DOLBY[ ._-]?VISION)\b/i.test(text)) flags.push('DV');
  if (/\bHDR(?:10\+?)?\b/i.test(text)) flags.push('HDR');
  if (/\b(?:HEVC|H[ ._-]?265|X265)\b/i.test(text)) flags.push('HEVC');
  else if (/\b(?:H[ ._-]?264|X264|AVC)\b/i.test(text)) flags.push('H264');
  if (/\bATMOS\b/i.test(text)) flags.push('Atmos');

  const languages = [];
  if (/\b(?:SK|SVK|SLOVAK|SLOVENSKY|SLOVENSKE)\b/i.test(upper)) languages.push('🇸🇰');
  if (/\b(?:CZ|CZE|CZECH|CESKY|CESKE)\b/i.test(upper)) languages.push('🇨🇿');
  if (/\b(?:EN|ENG|ENGLISH)\b/i.test(upper)) languages.push('🇬🇧');

  return { quality, flags, languages: [...new Set(languages)] };
}

export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value.toFixed(index >= 3 ? 2 : index >= 2 ? 1 : 0)} ${units[index]}`;
}

function seasonEpisodePatterns(season, episode) {
  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');
  return [
    new RegExp(`\\bS0?${season}[ ._-]*E0?${episode}\\b`, 'i'),
    new RegExp(`\\b0?${season}[xX]0?${episode}\\b`),
    new RegExp(`\\bS${s}E${e}\\b`, 'i'),
    new RegExp(`\\b(?:EP?|EPIZODA|EPISODE)[ ._-]*0?${episode}\\b`, 'i')
  ];
}

export function chooseVideoFile(files, { season = null, episode = null } = {}) {
  const videos = files
    .map((file, index) => ({ ...file, index: file.index ?? index }))
    .filter((file) => isVideoFile(file.path || file.name) && !isJunkVideo(file.path || file.name));

  if (!videos.length) return null;

  if (season != null && episode != null) {
    const patterns = seasonEpisodePatterns(season, episode);
    const explicit = videos.filter((file) => patterns.some((pattern) => pattern.test(file.path || file.name)));
    if (explicit.length) return explicit.sort((a, b) => Number(b.length || 0) - Number(a.length || 0))[0];

    // Pack fallback: when files are simply numbered, map episode number to filename number.
    const numbered = videos
      .map((file) => ({ file, numbers: (file.path || file.name).match(/\b\d{1,3}\b/g)?.map(Number) || [] }))
      .filter(({ numbers }) => numbers.includes(episode));
    if (numbered.length === 1) return numbered[0].file;
  }

  return videos.sort((a, b) => Number(b.length || 0) - Number(a.length || 0))[0];
}
