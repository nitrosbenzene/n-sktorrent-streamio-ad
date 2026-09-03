import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSeeds } from '../src/services/sktorrent.js';

test('parses SKTorrent Odosielaju seeder count', () => {
  assert.equal(parseSeeds('Velkost 2.20 GB | Odosielaju : 42 | Stahuju : 3'), 42);
});

test('parses accented Slovak seeder label', () => {
  assert.equal(parseSeeds('Odosielajú: 17'), 17);
});

test('keeps generic seeder fallbacks', () => {
  assert.equal(parseSeeds('Seeders: 8'), 8);
  assert.equal(parseSeeds('S: 5'), 5);
});
