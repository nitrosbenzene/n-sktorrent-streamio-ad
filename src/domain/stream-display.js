function formatBytes(bytes) {
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

function basename(path = '') {
  return String(path).split(/[\\/]/).pop() || '';
}

function uniqueText(values) {
  const seen = new Set();
  const result = [];
  for (const raw of values) {
    const value = String(raw || '').trim();
    if (!value) continue;
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function displayTitle(meta = {}) {
  const titles = uniqueText([
    meta.titleCz,
    meta.titleOriginal,
    meta.primaryTitle
  ]);
  const title = titles.slice(0, 2).join(' / ') || meta.imdbId || 'SKTorrent';
  return meta.year ? `${title} (${meta.year})` : title;
}

function qualityParts(candidate) {
  const parts = [];
  if (candidate.quality && candidate.quality !== 'Unknown') parts.push(candidate.quality);

  const flagMap = {
    DV: 'Dolby Vision',
    HDR: 'HDR',
    HEVC: 'HEVC',
    H264: 'H.264',
    Atmos: 'Atmos'
  };

  for (const flag of candidate.traits?.flags || []) {
    parts.push(flagMap[flag] || flag);
  }
  return uniqueText(parts);
}

export function formatStreamDisplay(candidate, { cached = false, type, season, episode } = {}) {
  const directTorBox = Boolean(cached && candidate.directUrl);
  const category = String(candidate.searchItem?.category || (type === 'series' ? 'TV' : 'FILM'))
    .trim()
    .toUpperCase();

  const name = `${directTorBox ? '[TB ⚡]' : '[P2P]'} SKT\n${category || 'TORRENT'}`;
  const lines = [displayTitle(candidate.meta)];

  if (type === 'series' && season != null && episode != null) {
    lines.push(`📺 Séria ${season} • Epizóda ${episode}`);
  }

  const languages = uniqueText(candidate.traits?.languages || []);
  const languageText = languages.length ? languages.join(' / ') : 'Neznámy jazyk';
  const quality = qualityParts(candidate);
  const qualityText = quality.length ? quality.join(' • ') : 'Kvalita neznáma';
  lines.push(`🔊 ${languageText}   |   🎥 ${qualityText}`);

  const fileSize = formatBytes(candidate.file?.length);
  const scrapedTorrentSize = String(candidate.searchItem?.sizeLabel || '').trim();
  const torrentSize = scrapedTorrentSize && scrapedTorrentSize !== '?'
    ? scrapedTorrentSize
    : formatBytes(candidate.torrent?.length);
  const seeds = Number.isFinite(Number(candidate.searchItem?.seeds))
    ? Number(candidate.searchItem.seeds)
    : 'N/A';
  lines.push(`💿 ${fileSize} (🧩 ${torrentSize})   |   👥 Seeders: ${seeds}`);

  const filename = basename(candidate.file?.path || candidate.file?.name);
  if (filename) lines.push(`📄 Súbor: ${filename}`);

  const torrentName = String(candidate.title || candidate.searchItem?.name || candidate.torrent?.name || '').trim();
  if (torrentName) lines.push(`🗂️ Torrent: ${torrentName}`);

  return {
    name,
    title: lines.join('\n')
  };
}
