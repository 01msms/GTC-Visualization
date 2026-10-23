'use strict';

// Optional development check. Runtime/release never imports Python.
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { readData1d } = require('../server/toolbox/case-store');
const { parseGtc, parseProfile, createDataset, analyse } = require('../shared/spatiotemporal');

async function main() {
    const directory = process.argv[2];
    if (!directory) throw new Error('Usage: node util/check-toolbox-parity.js <GTC output directory>');
    const output = await fs.mkdtemp(path.join(os.tmpdir(), 'gtc-python-parity-'));
    try {
        await promisify(execFile)(process.env.PYTHON_EXECUTABLE || (process.platform === 'win32' ? 'python' : 'python3'),
            [path.join(__dirname, 'toolbox-python-oracle.py'), '--case', directory, '--output', output]);
        const start = performance.now(), file = path.join(directory, 'data1d.out');
        const raw = await readData1d(file, (await fs.stat(file)).size);
        let profile = {};
        try { profile = parseProfile(await fs.readFile(path.join(directory, 'profile.dat'), 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const dataset = createDataset(raw, parseGtc(await fs.readFile(path.join(directory, 'gtc.out'), 'utf8')), profile);
        const readMs = performance.now() - start;
        const descriptor = JSON.parse(await fs.readFile(path.join(output, 'expected.json'), 'utf8'));
        const expected = await fs.readFile(path.join(output, 'expected.f64'));
        const checks = [];
        for (const item of descriptor) {
            const before = performance.now(), result = analyse(dataset, item.settings), series = result.series[item.settings.quantity];
            let maxRelative = 0, maxAbsolute = 0, count = 0;
            for (const [key, { offset, length }] of Object.entries(item.arrays)) {
                const values = series[key] || result[key];
                if (values.length !== length) throw new Error(`Shape mismatch: ${key}`);
                for (let i = 0; i < length; i++) {
                    const reference = expected.readDoubleLE((offset + i) * 8);
                    const delta = Math.abs(values[i] - reference);
                    if (delta > 1e-24 + Math.abs(reference) * 1e-10) throw new Error(`${item.settings.quantity}/${item.settings.units} ${key}[${i}]: ${values[i]} != ${reference}`);
                    maxAbsolute = Math.max(maxAbsolute, delta);
                    if (reference) maxRelative = Math.max(maxRelative, delta / Math.abs(reference));
                    count++;
                }
            }
            if (Math.abs(series.window_mean - item.window_mean) > 1e-24 + Math.abs(item.window_mean) * 1e-10) throw new Error('Window statistic mismatch');
            checks.push({ quantity: item.settings.quantity, units: item.settings.units, values: count,
                max_relative_error: maxRelative, max_absolute_error: maxAbsolute, analysis_and_comparison_ms: Math.round(performance.now() - before) });
        }
        console.log(JSON.stringify({ records: dataset.records, radial_points: dataset.nr, read_ms: Math.round(readMs), checks }, null, 2));
    } finally { await fs.rm(output, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
