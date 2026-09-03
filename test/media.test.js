import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseVideoFile,
  extractReleaseTraits,
  normalize,
  parseStremioId,
  releaseMatchesTitle
} from '../src/domain/media.js';

test('parses Stremio series id', () => {
  assert.deepEqual(parseStremioId('tt1234567:2:9'), { imdbId: 'tt1234567', season: 2, episode: 9 });
});

test('matches title aliases but rejects a conflicting year', () => {
  assert.equal(releaseMatchesTitle('Pelisky 1999 1080p CZ', ['Pelíšky'], 1999), true);
  assert.equal(releaseMatchesTitle('Pelisky 2008 1080p CZ', ['Pelíšky'], 1999), false);
});

test('normalizes Unicode punctuation in stylized titles', () => {
  assert.equal(normalize('WALL·E'), 'wall e');
  assert.equal(releaseMatchesTitle('WALL E 2008 1080p CZ', ['WALL·E'], 2008), true);
  assert.equal(releaseMatchesTitle('WALL-E.2008.2160p.UHD', ['WALL·E'], 2008), true);
});

test('matches accent-free localized aliases', () => {
  assert.equal(releaseMatchesTitle('Balerina 2016 1080p CZ', ['Leap!', 'Balerína', 'Ballerina'], 2016), true);
  assert.equal(releaseMatchesTitle('Ballerina.2016.720p', ['Leap!', 'Balerína', 'Ballerina'], 2016), true);
});

test('selects explicit episode from a pack', () => {
  const files = [
    { path: 'Show.S01E01.mkv', length: 100, index: 0 },
    { path: 'Show.S01E02.mkv', length: 200, index: 1 },
    { path: 'sample.mkv', length: 500, index: 2 }
  ];
  assert.equal(chooseVideoFile(files, { season: 1, episode: 2 }).index, 1);
});

test('extracts release traits', () => {
  const traits = extractReleaseTraits('Movie.2160p.DV.HDR.HEVC.Atmos.CZ.SK.mkv');
  assert.equal(traits.quality, '4K');
  assert.ok(traits.flags.includes('DV'));
  assert.ok(traits.flags.includes('HDR'));
  assert.ok(traits.languages.includes('🇨🇿'));
  assert.ok(traits.languages.includes('🇸🇰'));
});
