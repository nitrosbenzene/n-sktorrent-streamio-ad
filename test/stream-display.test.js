import test from 'node:test';
import assert from 'node:assert/strict';
import { formatStreamDisplay } from '../src/domain/stream-display.js';

function candidate(overrides = {}) {
  return {
    directUrl: 'https://example.test/video.mkv',
    quality: '1080p',
    traits: {
      flags: ['HDR', 'H264'],
      languages: ['🇨🇿', '🇸🇰']
    },
    meta: {
      imdbId: 'tt0167331',
      titleCz: 'Pelíšky',
      titleOriginal: 'Cosy Dens',
      primaryTitle: 'Pelíšky',
      year: 1999
    },
    searchItem: {
      name: 'Pelisky.1999.1080p.CZ.SK.HDR.x264',
      sizeLabel: '2.20 GB',
      seeds: 42,
      category: 'Filmy CZ/SK'
    },
    torrent: {
      name: 'Pelisky.1999.1080p.CZ.SK.HDR.x264',
      length: 2362232013
    },
    file: {
      path: 'Movies/Pelisky.1999.1080p.mkv',
      length: 2147483648,
      index: 0
    },
    title: 'Pelisky.1999.1080p.CZ.SK.HDR.x264',
    ...overrides
  };
}

test('formats cached movie results like the reference SKTorrent addon', () => {
  const result = formatStreamDisplay(candidate(), { cached: true, type: 'movie' });

  assert.equal(result.name, '[TB ⚡] SKT\nFILMY CZ/SK');
  assert.equal(result.title, [
    'Pelíšky / Cosy Dens (1999)',
    '🔊 🇨🇿 / 🇸🇰   |   🎥 1080p • HDR • H.264',
    '💿 2.00 GB (🧩 2.20 GB)   |   👥 Seeders: 42',
    '📄 Súbor: Pelisky.1999.1080p.mkv',
    '🗂️ Torrent: Pelisky.1999.1080p.CZ.SK.HDR.x264'
  ].join('\n'));
});

test('labels non-direct results as P2P and includes episode information', () => {
  const result = formatStreamDisplay(candidate({ directUrl: null }), {
    cached: false,
    type: 'series',
    season: 2,
    episode: 7
  });

  assert.equal(result.name, '[P2P] SKT\nFILMY CZ/SK');
  assert.match(result.title, /📺 Séria 2 • Epizóda 7/);
});
