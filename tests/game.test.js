'use strict';
// Coverage for pure helpers in game.js: bend-curve interpolation, track
// instrument labeling, HTML escaping.
// Runs under the org reusable CI as `node tests/game.test.js`.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function freshPlugin() {
    global.document = {
        getElementById: () => null,
        head: { appendChild: () => {} },
        createElement: () => ({ style: {} }),
    };
    const file = path.join(__dirname, '..', 'game.js');
    delete require.cache[require.resolve(file)];
    return require(file);
}

const mod = freshPlugin();

test('interpolateBend clamps to the first point before the curve starts', () => {
    const bends = [{ t_ms: 1000, cents: 50 }, { t_ms: 2000, cents: 0 }];
    assert.equal(mod.interpolateBend(bends, 0), 50);
    assert.equal(mod.interpolateBend(bends, 1000), 50);
});

test('interpolateBend clamps to the last point after the curve ends', () => {
    const bends = [{ t_ms: 1000, cents: 50 }, { t_ms: 2000, cents: 0 }];
    assert.equal(mod.interpolateBend(bends, 5000), 0);
    assert.equal(mod.interpolateBend(bends, 2000), 0);
});

test('interpolateBend linearly interpolates between two segments', () => {
    const bends = [{ t_ms: 0, cents: 0 }, { t_ms: 1000, cents: 100 }];
    assert.equal(mod.interpolateBend(bends, 500), 50);
    assert.equal(mod.interpolateBend(bends, 250), 25);
});

test('interpolateBend walks multi-point curves and picks the right segment', () => {
    const bends = [
        { t_ms: 0, cents: 0 },
        { t_ms: 1000, cents: 100 },
        { t_ms: 2000, cents: -50 },
    ];
    assert.equal(mod.interpolateBend(bends, 1500), 25); // midway 100 -> -50
    assert.equal(mod.interpolateBend(bends, 1000), 100);
});

test('interpolateBend returns 0 for empty or missing bends', () => {
    assert.equal(mod.interpolateBend([], 500), 0);
    assert.equal(mod.interpolateBend(null, 500), 0);
    assert.equal(mod.interpolateBend(undefined, 500), 0);
});

test('interpolateBend guards against a zero-width segment (same t_ms twice)', () => {
    const bends = [{ t_ms: 500, cents: 10 }, { t_ms: 500, cents: 90 }];
    // Math.max(1, 0) denominator avoids a divide-by-zero -> finite result.
    const result = mod.interpolateBend(bends, 500);
    assert.ok(Number.isFinite(result));
});

test('centerInstrumentLabel formats string+fret+note when all present', () => {
    const track = { instrument: { string: 'G', fret: 7, base_note: 'D4' } };
    assert.equal(mod.centerInstrumentLabel(track), 'Play G string fret 7 — D4');
});

test('centerInstrumentLabel omits fret/note when absent', () => {
    assert.equal(mod.centerInstrumentLabel({ instrument: { string: 'D' } }), 'Play D string');
});

test('centerInstrumentLabel returns empty string with no instrument/string', () => {
    assert.equal(mod.centerInstrumentLabel({}), '');
    assert.equal(mod.centerInstrumentLabel({ instrument: {} }), '');
});

test('escapeHtml escapes the five XSS-relevant characters', () => {
    assert.equal(mod.escapeHtml(`<script>"it's" & <b>bold</b></script>`),
        '&lt;script&gt;&quot;it&#39;s&quot; &amp; &lt;b&gt;bold&lt;/b&gt;&lt;/script&gt;');
});

test('escapeHtml tolerates null/undefined/numbers', () => {
    assert.equal(mod.escapeHtml(null), '');
    assert.equal(mod.escapeHtml(undefined), '');
    assert.equal(mod.escapeHtml(42), '42');
});
