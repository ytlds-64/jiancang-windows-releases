'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { activeAssetProperties, normalizeAssetProperties, assetPropertyMatches } = require('../ui/asset-filters.js');

const megabyte = 1024 ** 2;
const matches = (filter, asset) => assetPropertyMatches(asset, activeAssetProperties(filter));

test('uses nonoverlapping size bands and skips unknown sizes', () => {
  assert.equal(matches({ size: 'under-1mb' }, { byteCount: megabyte - 1 }), true);
  assert.equal(matches({ size: 'under-1mb' }, { byteCount: megabyte }), false);
  assert.equal(matches({ size: '1-10mb' }, { byteCount: megabyte }), true);
  assert.equal(matches({ size: '1-10mb' }, { byteCount: 10 * megabyte }), false);
  assert.equal(matches({ size: '10-100mb' }, { byteCount: 10 * megabyte }), true);
  assert.equal(matches({ size: '100mb-plus' }, { byteCount: 100 * megabyte }), true);
  assert.equal(matches({ size: 'under-1mb' }, { byteCount: 0, available: true }), true);
  assert.equal(matches({ size: 'under-1mb' }, { byteCount: 0, available: false }), false);
  for (const byteCount of [undefined, null, -20, Infinity, 0.5, '1024']) {
    assert.equal(matches({ size: 'under-1mb' }, { byteCount }), false, String(byteCount));
  }
});

test('matches both dimensions regardless of orientation and only counts finite known sides', () => {
  assert.equal(matches({ resolution: '4k' }, { width: 2160, height: 3840 }), true);
  assert.equal(matches({ resolution: '4k' }, { width: 3840, height: 1080 }), false);
  assert.equal(matches({ resolution: '1080p' }, { width: 1920, height: 1080 }), true);
  assert.equal(matches({ resolution: '1080p' }, { width: 1800, height: 1800 }), false);
  assert.equal(matches({ resolution: 'under-720p' }, { width: 1280, height: 719 }), true);
  assert.equal(matches({ resolution: 'under-720p' }, { width: 720, height: 1280 }), false);
  assert.equal(matches({ resolution: 'under-720p' }, { width: 0, height: 500 }), false);
  assert.equal(matches({ resolution: '8k' }, { width: Infinity, height: 4320 }), false);
});

test('combines metadata property filters and chooses the correct band at exact time boundaries', () => {
  const clip = { kind: 'video', byteCount: 2 * megabyte, width: 1080, height: 1920, duration: 60, available: false };
  const criteria = { size: '1-10mb', resolution: '1080p', duration: '1m-5m', availability: 'unavailable' };
  assert.equal(matches(criteria, clip), true);
  assert.equal(matches({ ...criteria, availability: 'available' }, clip), false);
  assert.equal(matches({ ...criteria, duration: '15s-1m' }, clip), false);
  assert.equal(matches({ duration: '15s-1m' }, { duration: 15 }), true);
  assert.equal(matches({ duration: 'under-15s' }, { duration: 15 }), false);
  assert.equal(matches({ duration: '5m-plus' }, { duration: 300 }), true);
  for (const duration of [null, undefined, 0, Infinity, -1, '14']) {
    assert.equal(matches({ duration: 'under-15s' }, { duration }), false, String(duration));
  }
  assert.equal(matches({ availability: 'unavailable' }, { kind: 'link', available: false }), false);
  assert.equal(matches({ availability: 'unavailable' }, {}), false);
  assert.deepEqual(normalizeAssetProperties(criteria), criteria);
});

test('preserves legacy criteria and ignores unknown preset tokens', () => {
  assert.deepEqual(normalizeAssetProperties(null), {});
  assert.deepEqual(normalizeAssetProperties({ format: 'png', size: 'any', resolution: 1200, duration: '3h' }), {});
  assert.deepEqual(normalizeAssetProperties({ availability: 'available', unknown: '1-10mb' }), { availability: 'available' });
  assert.equal(matches({ size: 'any' }, {}), true);
});
