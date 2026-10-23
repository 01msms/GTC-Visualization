'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { promisify } = require('util');
const { gzip } = require('zlib');
const { numeric, parseGtc, parseProfile, createDataset } = require('../../shared/spatiotemporal');
const { MAGIC } = require('../../shared/spatiotemporal-wire');
const gzipAsync = promisify(gzip);

async function readData1d(filename, size, onProgress = () => {}) {
    const header = [], diRows = [], dfRows = [];
    let nr, channels, frameSize, fastStart, di, df, offset = 0, total = 0;
    let carry = '', readBytes = 0, firstChunk = true;
    const stream = fs.createReadStream(filename, { encoding: 'utf8', highWaterMark: 256 * 1024, end: Math.max(0, size - 1) });
    function accept(token) {
        const value = numeric(token);
        if (header.length < 7) {
            if (!Number.isSafeInteger(value)) throw new Error('data1d.out 头部七个参数必须为整数。');
            header.push(value);
            if (header.length === 7) {
                nr = header[1];
                if (nr < 2 || header[2] < 1 || header[4] < 1 || header[5] < 0 || header[6] < 0) throw new Error('data1d.out 头部网格或通道参数无效。');
                channels = header[2] * header[4] + header[5] * header[6];
                frameSize = nr * channels;
                if (!Number.isSafeInteger(frameSize) || frameSize > 1e8) throw new Error('data1d.out 诊断帧过大，请检查文件头。');
                fastStart = header[2] >= 3 ? 2 * header[4] * nr : -1;
                di = new Float64Array(nr); df = fastStart < 0 ? null : new Float64Array(nr);
            }
            return;
        }
        if (offset < nr) di[offset] = value;
        if (df && offset >= fastStart && offset < fastStart + nr) df[offset - fastStart] = value;
        offset++; total++;
        if (offset === frameSize) {
            diRows.push(di); if (df) dfRows.push(df);
            di = new Float64Array(nr); df = df ? new Float64Array(nr) : null; offset = 0;
        }
    }
    for await (let chunk of stream) {
        readBytes += Buffer.byteLength(chunk);
        if (firstChunk) { chunk = chunk.replace(/^\uFEFF/, ''); firstChunk = false; }
        chunk = carry + chunk;
        const last = chunk.search(/\S+$/);
        carry = last >= 0 ? chunk.slice(last) : '';
        const complete = last >= 0 ? chunk.slice(0, last) : chunk;
        for (const match of complete.matchAll(/\S+/g)) accept(match[0]);
        onProgress({ phase: 'reading', bytes: Math.min(readBytes, size), total: size, records: diRows.length });
    }
    if (carry.trim()) accept(carry.trim());
    if (header.length < 7 || diRows.length < 2) throw new Error('data1d.out 需要至少两条完整诊断记录。');
    const flatten = rows => {
        const array = new Float64Array(rows.length * nr);
        rows.forEach((row, i) => array.set(row, i * nr));
        return array;
    };
    return { header, nr, records: diRows.length, ignored_trailing_values: total % frameSize,
        di: flatten(diRows), ...(dfRows.length ? { df: flatten(dfRows) } : {}) };
}

function encodeDataset(dataset) {
    let offset = 0;
    const metadata = {}, arrays = [], buffers = [];
    for (const [name, value] of Object.entries(dataset)) {
        if (value instanceof Float64Array) {
            arrays.push({ name, offset, length: value.length }); offset += value.length;
            const buffer = Buffer.allocUnsafe(value.length * 8);
            for (let i = 0; i < value.length; i++) buffer.writeDoubleLE(value[i], i * 8);
            buffers.push(buffer);
        } else metadata[name] = value;
    }
    const json = Buffer.from(JSON.stringify({ ...metadata, arrays }));
    const header = Buffer.alloc(Math.ceil((12 + json.length) / 8) * 8);
    header.write(MAGIC, 0, 'ascii'); header.writeUInt32LE(json.length, 8); json.copy(header, 12);
    return Buffer.concat([header, ...buffers]);
}

function createCaseStore({ maxBytes = 192 * 1024 * 1024, maxCases = 2 } = {}) {
    const cache = new Map(), pending = new Map(), progress = new Map();
    let bytes = 0;
    async function load(folder) {
        if (pending.has(folder.directory)) return pending.get(folder.directory);
        const job = (async () => {
            const names = ['gtc.out', 'data1d.out', 'profile.dat'];
            const stats = await Promise.all(names.map(async name => {
                try { return await fsp.stat(path.join(folder.directory, name)); }
                catch (error) { if (name === 'profile.dat' && error.code === 'ENOENT') return null; throw error; }
            }));
            const signature = stats.map(s => s ? `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}` : '-').join('|');
            const cached = cache.get(folder.directory);
            if (cached?.signature === signature) {
                cache.delete(folder.directory); cache.set(folder.directory, cached);
                progress.set(folder.directory, { phase: 'ready', cached: true }); return cached;
            }
            progress.set(folder.directory, { phase: 'reading', bytes: 0, total: stats[1].size, records: 0 });
            const [raw, gtcText, profileText] = await Promise.all([
                readData1d(path.join(folder.directory, 'data1d.out'), stats[1].size, p => progress.set(folder.directory, p)),
                fsp.readFile(path.join(folder.directory, 'gtc.out'), 'utf8'),
                stats[2] ? fsp.readFile(path.join(folder.directory, 'profile.dat'), 'utf8') : null,
            ]);
            progress.set(folder.directory, { phase: 'preparing' });
            let profile = {};
            if (profileText !== null) {
                try { profile = parseProfile(profileText); }
                catch (error) { profile = { profile_error: error.message }; }
            }
            const dataset = createDataset(raw, parseGtc(gtcText), profile);
            dataset.label = folder.label;
            const payload = encodeDataset(dataset), zipped = await gzipAsync(payload, { level: 1 });
            const entry = { signature, payload, zipped, size: payload.length + zipped.length };
            if (cached) { cache.delete(folder.directory); bytes -= cached.size; }
            if (entry.size <= maxBytes) {
                cache.set(folder.directory, entry); bytes += entry.size;
                while (cache.size > maxCases || bytes > maxBytes) {
                    const oldest = cache.keys().next().value;
                    bytes -= cache.get(oldest).size; cache.delete(oldest);
                }
            }
            progress.set(folder.directory, { phase: 'ready', cached: false }); return entry;
        })();
        pending.set(folder.directory, job);
        try { return await job; }
        catch (error) { progress.set(folder.directory, { phase: 'error', error: error.message }); throw error; }
        finally { pending.delete(folder.directory); }
    }
    return { load, status: directory => progress.get(directory) || { phase: 'idle' } };
}

module.exports = { readData1d, encodeDataset, createCaseStore };
