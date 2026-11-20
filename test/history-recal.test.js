/** Tests for History recalculation control positioning. */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

it('scales the mode components to the fit window and clears an unresolved frequency', async t => {
    const previousDocument = global.document;
    const previousWindow = global.window;
    global.window = {};
    global.document = { baseURI: new URL('../public/', pathToFileURL(__filename)).href };
    t.after(() => {
        global.document = previousDocument;
        global.window = previousWindow;
    });
    const { historyMode } = await import('../client/plotting/plot-data-process.js');
    const { default: state } = await import('../client/control/state.js');
    const previousStep = state.timeStep;
    t.after(() => { state.timeStep = previousStep; });
    state.timeStep = 1;
    const x = Array.from({ length: 100 }, (_, i) => i + 1);
    const amplitude = x.map(t => Math.exp(0.1 * t) * (t > 90 ? 1e9 : 1));
    const components = [Math.cos, Math.sin].map(wave => ({
        x, y: x.map((t, i) => amplitude[i] * wave(2 * Math.PI * t / 10)),
    }));
    const figure = data => ({ data, layout: { title: {}, xaxis: {}, yaxis: {} } });
    const frequency = figure([]);
    const spectrum = figure([]);
    const figures = [figure(components), figure([{ x, y: amplitude }]), frequency, spectrum];
    await historyMode(figures, [0.1, 0.8]);
    assert.deepEqual(frequency.layout.xaxis.range, [10, 80]);
    assert.match(frequency.layout.title.text, /0\.62832/);
    assert.ok(frequency.layout.yaxis.range[0] > -2 && frequency.layout.yaxis.range[1] < 2);
    assert.ok(frequency.data[0].y.at(-1) > 1e8);
    assert.equal(frequency.data.length, 3);

    await historyMode(figures, [0.1, 0.8], [0.99, 1]);
    assert.deepEqual(frequency.layout.xaxis.range, [99, 100]);
    assert.ok(frequency.layout.yaxis.range[1] > 1e8);
    assert.match(frequency.layout.title.text, /fewer than two peaks/);
    assert.equal(frequency.data.length, 2);
    assert.equal(spectrum.data[0].x.length, 2);
});

describe('History recalculation control positioning', () => {
    it('pins when the control anchor reaches its top offset', async () => {
        const originalWindow = global.window;
        global.window = {};
        let updateHistoryRecalPosition;
        try {
            ({ updateHistoryRecalPosition } = await import(
                '../client/plotting/history-recal.js'
            ));
        } finally {
            global.window = originalWindow;
        }
        const classes = new Set();
        const control = {
            classList: {
                toggle(name, enabled) {
                    if (enabled) {
                        classes.add(name);
                    } else {
                        classes.delete(name);
                    }
                },
            },
        };
        let anchorTop = 21;
        const anchor = {
            getBoundingClientRect() {
                return { top: anchorTop };
            },
        };

        updateHistoryRecalPosition(anchor, control);
        assert.equal(classes.has('history-recalculate-pinned'), false);

        anchorTop = 20;
        updateHistoryRecalPosition(anchor, control);
        assert.equal(classes.has('history-recalculate-pinned'), true);

        anchorTop = 50;
        updateHistoryRecalPosition(anchor, control);
        assert.equal(classes.has('history-recalculate-pinned'), false);
    });
});
