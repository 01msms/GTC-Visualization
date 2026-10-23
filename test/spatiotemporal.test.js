'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const reference = require('./fixtures/spatiotemporal-python.json');
const core = require('../shared/spatiotemporal');
const { readData1d, encodeDataset, createCaseStore } = require('../server/toolbox/case-store');
const { decodeDataset } = require('../shared/spatiotemporal-wire');
const figures = import('../client/toolbox/figures.js');
const register = require('../server/di-spatiotemporal-toolbox');

function close(actual, expected, label = '') {
    if (Array.isArray(expected) || ArrayBuffer.isView(expected)) {
        assert.equal(actual.length, expected.length, `${label} length`);
        expected.forEach((v, i) => close(actual[i], v, `${label}[${i}]`));
    } else assert.ok(Math.abs(actual - expected) <= Math.max(1e-24, Math.abs(expected) * 5e-12), `${label}: ${actual} != ${expected}`);
}
async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gtc-toolbox-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const files = { gtc: 'gtc.out', data: 'data1d.out', profile: 'profile.dat' };
    for (const [key, filename] of Object.entries(files)) await fs.writeFile(path.join(directory, filename), reference.inputs[key]);
    const file = path.join(directory, 'data1d.out');
    const raw = await readData1d(file, (await fs.stat(file)).size);
    const dataset = core.createDataset(raw, core.parseGtc(reference.inputs.gtc), core.parseProfile(reference.inputs.profile));
    return { directory, raw, dataset };
}

test('JavaScript matches independent Python float64 arrays for all four quantities and both unit systems', async t => {
    const { raw, dataset } = await fixture(t);
    assert.equal(raw.records, 9); assert.equal(raw.nr, 4); assert.equal(dataset.nr, 5);
    assert.equal(raw.ignored_trailing_values, 3);
    assert.equal(dataset.inferred.tref_ev, 1200);
    assert.equal(dataset.parameters.ion_density_column_1based, 7);
    for (const { settings, expected } of reference.cases) {
        const result = core.analyse(dataset, settings), series = result.series[settings.quantity];
        close(series.values, expected.values.flat(), `${settings.quantity}/${settings.units} matrix`);
        close(series.mean, expected.mean_time, 'radial mean');
        close(series.smooth, expected.smooth, 'Savitzky–Golay including edges');
        close(series.window_mean, expected.window_mean, 'window mean');
        close(series.window_profile_mean, expected.window_profile_mean, 'window profile');
        for (const key of ['weights', 'radius_a', 'radius_m', 'physical_time']) close(result[key], expected[key], key);
        for (const key of ['ni_si', 'grad_ni_si']) close(result.profiles[key], expected[key], key);
        if (settings.quantity === 'gammaf') for (const key of ['nf_si', 'grad_nf_si']) close(result.profiles[key], expected[key], key);
        close(result.time_range, expected.time_range, 'time range');
    }
});

test('smoothing and view ranges cannot alter raw matrices or signed flux statistics', async t => {
    const { dataset } = await fixture(t);
    const settings = { ...reference.cases[4].settings, time_min: null, time_max: null, smooth_window: 1 };
    const a = core.analyse(dataset, settings);
    const b = core.analyse(dataset, { ...settings, smooth_window: 9, time_min: .08, time_max: .2, time_axis: 'step', units: 'si' });
    close(a.series.gamma.values, b.series.gamma.values);
    close(a.series.gamma.mean, b.series.gamma.mean);
    close(a.series.gamma.window_mean, b.series.gamma.window_mean);
    const linear = Float64Array.from({ length: 9 }, (_, i) => 7 - i * 2);
    close(core.smoothTrace(linear, 9), linear);
    close(core.smoothTrace(linear, 3), linear);
    assert.throws(() => core.smoothTrace(linear, 4), /平滑窗口/);
    assert.throws(() => core.analyse(dataset, { ...settings, mean_rmin: 8 }), /径向平均/);
    assert.throws(() => core.analyse(dataset, { ...settings, time_max: 8 }), /时间范围/);
});

test('Gamma rejects missing species, absent density normalization, FELOAD, and extrapolated profile coordinates', async t => {
    const { dataset } = await fixture(t), s = reference.cases[6].settings;
    assert.throws(() => core.analyse({ ...dataset, df: undefined }, s), /第三物种/);
    assert.throws(() => core.analyse({ ...dataset, profile_psi: undefined }, s), /profile.dat/);
    assert.throws(() => core.analyse({ ...dataset, parameters: { ...dataset.parameters, fast_electron_load: 1 } }, s), /FELOAD/);
    assert.throws(() => core.analyse({ ...dataset, parameters: { ...dataset.parameters, profile_psiw: 1 } }, s), /不会外推/);
    assert.throws(() => core.analyse({ ...dataset, inferred: { ...dataset.inferred, nref_19: null } }, { start: 1, end: 5, quantity: 'gamma' }), /参考密度/);
});

test('stream reader rejects malformed values and keeps complete snapshot frames only', async t => {
    const { directory } = await fixture(t);
    const file = path.join(directory, 'bad.out');
    await fs.writeFile(file, reference.inputs.data.replace('D-05', 'broken'));
    await assert.rejects(readData1d(file, (await fs.stat(file)).size), /无法解析数值/);
    await fs.writeFile(file, reference.inputs.data.replace('5000', '5000.5'));
    await assert.rejects(readData1d(file, (await fs.stat(file)).size), /必须为整数/);
});

test('comparison figures preserve transpose, shared D scale, Gamma dual-axis scale, and raw-stat metadata', async t => {
    const { buildFigures } = await figures;
    const { dataset } = await fixture(t), settings = { ...reference.cases[0].settings, quantity: 'compare' };
    const d = core.analyse(dataset, settings), figure = buildFigures(d, { view: 'combined' })[0];
    const maps = figure.data.filter(t => t.type === 'heatmap');
    assert.equal(maps.length, 2); assert.equal(maps[0].coloraxis, maps[1].coloraxis);
    close(maps[1].z[3][2], d.series.df.values[2 * d.nr + 3]);
    close(figure.layout.meta.statistics.di.window_mean, d.series.di.window_mean);
    const gamma = core.analyse(dataset, { ...settings, compare_kind: 'gamma' });
    const g = buildFigures(gamma, { view: 'means', align_gamma_zero: true })[0];
    const fast = g.data.find(t => t.name.startsWith('Γ𝒻'));
    close(fast.y, Array.from(gamma.series.gammaf.mean, v => v * 1000));
    assert.equal(fast.yaxis, 'y2');
    assert.equal(g.layout.yaxis.range[0], -g.layout.yaxis.range[1]);
    assert.equal(g.layout.yaxis2.range[0], -g.layout.yaxis2.range[1]);
    for (const view of ['maps', 'means', 'combined', 'i_single', 'f_single']) assert.ok(buildFigures(gamma, { view })[0].data.length);
    const compact = buildFigures(gamma, { view: 'means', plot_width: 300 })[0];
    assert.ok(compact.layout.margin.l + compact.layout.margin.r < 150);
    close(compact.data.find(t => t.name.startsWith('Γ𝒻')).y, fast.y);
    const extra = core.analyse(dataset, { ...settings, extra_di_gamma: true, check_gradient: true });
    assert.deepEqual(buildFigures(extra, { view: 'maps' }).map(f => f.key), ['main', 'di', 'gamma', 'gradient']);
});

test('binary transport is lossless and rejects truncated payloads', async t => {
    const { dataset } = await fixture(t), payload = encodeDataset(dataset);
    const bytes = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
    const decoded = decodeDataset(bytes);
    close(decoded.di, dataset.di); close(decoded.df, dataset.df); close(decoded.psi, dataset.psi);
    assert.equal(decoded.records, dataset.records);
    assert.throws(() => decodeDataset(bytes.slice(0, bytes.byteLength - 8)), /不完整/);
});

test('HTTP case loading shares simultaneous reads, invalidates changed files, and excludes arbitrary paths', async t => {
    const { directory } = await fixture(t), folder = { value: '.', label: 'fixture', directory, hasProfile: true };
    const store = createCaseStore(), [a, b] = await Promise.all([store.load(folder), store.load(folder)]);
    assert.equal(a, b);
    assert.equal(await store.load(folder), a);
    await fs.appendFile(path.join(directory, 'gtc.out'), '\nETEMP0 = 1500\n');
    const c = await store.load(folder); assert.notEqual(c, a);
    const app = express(); register(app, { getOutputFolders: () => [folder], store, viewPath: path.join(__dirname, '../views/toolbox.pug') });
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/api/toolbox/data?folder=.`);
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-encoding'), 'gzip');
    const data = decodeDataset(await response.arrayBuffer()); assert.equal(data.inferred.tref_ev, 1500);
    const identity = await fetch(`${base}/api/toolbox/data?folder=.`, { headers: { 'Accept-Encoding': 'identity' } });
    assert.equal(identity.headers.get('content-encoding'), null); assert.equal((await identity.arrayBuffer()).byteLength, c.payload.length);
    assert.equal((await fetch(`${base}/api/toolbox/data?folder=../../other`)).status, 404);
    const page = await fetch(`${base}/toolbox`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.doesNotMatch(html.match(/<input[^>]*name="mean_ymin"[^>]*>/)[0], /\smin=/);
});
