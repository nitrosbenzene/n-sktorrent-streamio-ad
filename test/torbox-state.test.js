import test from 'node:test';
import assert from 'node:assert/strict';
import { isTorBoxDownloading } from '../src/services/torbox.js';

test('recognizes active TorBox download states', () => {
  assert.equal(isTorBoxDownloading({ download_finished: false, download_state: 'downloading' }), true);
  assert.equal(isTorBoxDownloading({ download_finished: false, download_state: 'metaDL' }), true);
  assert.equal(isTorBoxDownloading({ download_finished: false, download_state: 'stalled (no seeds)' }), true);
  assert.equal(isTorBoxDownloading({ download_finished: false, download_state: 'checkingResumeData' }), true);
  assert.equal(isTorBoxDownloading({ download_finished: false, download_state: 'queued' }), true);
  assert.equal(isTorBoxDownloading({ download_finished: false, download_state: 'unknown', active: true }), true);
});

test('does not mark completed or inactive TorBox items as downloading', () => {
  assert.equal(isTorBoxDownloading({ download_finished: true, download_state: 'uploading', active: true }), false);
  assert.equal(isTorBoxDownloading({ download_finished: false, download_state: 'paused', active: false }), false);
  assert.equal(isTorBoxDownloading({ download_finished: false, download_state: 'failed', active: false }), false);
  assert.equal(isTorBoxDownloading({ download_finished: false, download_state: 'expired', active: false }), false);
});
