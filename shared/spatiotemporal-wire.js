'use strict';

// Aligned JSON header followed by little-endian float64 arrays; keeps full precision.
const MAGIC = 'GTCST001';
function decodeDataset(buffer) {
    const bytes = new Uint8Array(buffer), view = new DataView(buffer);
    if (bytes.length < 16 || new TextDecoder().decode(bytes.subarray(0, 8)) !== MAGIC) throw new Error('算例数据格式无效，请刷新后重试。');
    const size = view.getUint32(8, true), start = Math.ceil((12 + size) / 8) * 8;
    if (start > bytes.length) throw new Error('算例数据传输不完整。');
    const { arrays, ...dataset } = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + size)));
    for (const { name, offset, length } of arrays) {
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || start + (offset + length) * 8 > bytes.length) throw new Error('算例数组传输不完整。');
        dataset[name] = new Float64Array(buffer, start + offset * 8, length);
    }
    return dataset;
}
module.exports = { MAGIC, decodeDataset };
