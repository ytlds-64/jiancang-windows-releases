'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '..', 'ui', 'continuous-gallery.js'), 'utf8');
const asset = (id, height = 100, importing = false) => ({ id, width: 100, height, importing });

function fixture(assets, { layout = 'masonry', viewportHeight = 120 } = {}) {
  const document = { activeElement: null };
  const window = {};
  runInNewContext(script, { window, document, ResizeObserver: class { observe() {} }, matchMedia: () => ({ matches: true }) });
  const scroller = { scrollTop: 0, clientTop: 0, clientHeight: viewportHeight, dataset: {}, addEventListener() {},
    style: { setProperty() {} }, getBoundingClientRect: () => ({ top: 0 }) };
  const gallery = { clientWidth: 324, style: {}, classList: { toggle() {} }, insertBefore() {},
    getBoundingClientRect: () => ({ top: -scroller.scrollTop }) };
  const view = window.createContinuousGallery({ gallery, scroller, cardKey: item => item.id, updateCard() {},
    makeCard(item) {
      return { dataset: { assetId: item.id }, style: { setProperty() {} }, getAttribute() {}, setAttribute() {}, remove() {},
        focus() { document.activeElement = this; } };
    } });
  view.render(assets, { layout, tileSize: 100, captions: false });
  return { view, scroller, document };
}

test('masonry arrow keys move to visually aligned tiles in adjacent columns', () => {
  const input = [asset('a', 320), asset('b', 80), asset('c', 55), asset('d', 120), asset('e', 85),
    asset('f', 80), asset('g', 50), asset('h', 45), asset('i', 40), asset('j')];
  const { view } = fixture(input);
  assert.equal(view.neighbor('a', 'ArrowRight'), 'e');
  assert.equal(view.neighbor('d', 'ArrowLeft'), 'e');
  assert.equal(view.neighbor('d', 'ArrowUp'), 'c');
  assert.equal(view.neighbor('d', 'ArrowDown'), 'g');

  view.render(input.map(item => ({ ...item, importing: item.id === 'e' })));
  assert.equal(view.neighbor('a', 'ArrowRight'), 'f');
  assert.equal(view.neighbor('e', 'ArrowRight'), null);

  const tied = fixture([asset('a', 200), asset('b', 94), asset('c', 200), asset('d', 94)]).view;
  assert.equal(tied.neighbor('a', 'ArrowRight'), 'b');
});

test('masonry wraps at both visual edges and preserves equal-height navigation', () => {
  const input = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => asset(id));
  for (const layout of ['masonry', 'rows']) {
    const { view } = fixture(input, { layout });
    assert.equal(view.neighbor('c', 'ArrowRight'), 'd');
    assert.equal(view.neighbor('d', 'ArrowLeft'), 'c');
    assert.equal(view.neighbor('b', 'ArrowDown'), 'e');
    assert.equal(view.neighbor('e', 'ArrowUp'), 'b');
    assert.equal(view.neighbor('a', 'ArrowLeft'), null);
    assert.equal(view.neighbor('f', 'ArrowRight'), null);
  }
});

test('masonry can navigate to a card outside the virtualized viewport', () => {
  const { view, scroller, document } = fixture([
    asset('a', 440), asset('b', 80), asset('c', 80), asset('d', 400), asset('e', 400), asset('f'),
  ]);
  assert.equal(view.renderedCard('f'), undefined);
  const next = view.neighbor('c', 'ArrowRight');
  assert.equal(next, 'f');
  const focused = view.focus(next);
  assert.equal(focused?.dataset.assetId, 'f');
  assert.equal(document.activeElement, focused);
  assert.ok(scroller.scrollTop > 0);
});
