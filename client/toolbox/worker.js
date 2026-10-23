import wire from '../../shared/spatiotemporal-wire.js';
import core from '../../shared/spatiotemporal.js';
const { decodeDataset } = wire;
const { DEFAULTS, analyse } = core;

let dataset;
self.onmessage = ({ data: message }) => {
    const { id, type } = message;
    try {
        if (type === 'load') {
            dataset = decodeDataset(message.buffer);
            const defaults = { ...DEFAULTS, ...dataset.inferred,
                start: dataset.records < 1600 ? 1 : 1600, end: Math.min(dataset.records, 2000) };
            self.postMessage({ id, result: {
                defaults, label: dataset.label, records: dataset.records, nr: dataset.nr,
                source_radial_points: dataset.source_radial_points, parameters: dataset.parameters,
                inferred: dataset.inferred, warnings: dataset.warnings, profile_error: dataset.profile_error,
                hasFast: !!dataset.df, hasProfile: !!dataset.profile_psi,
                radius_range: [dataset.radius_r0[0] * defaults.r0 / defaults.a, dataset.radius_r0[dataset.nr - 1] * defaults.r0 / defaults.a],
                time_end: dataset.records * defaults.tstep,
            } });
        } else if (type === 'analyse') {
            if (!dataset) throw new Error('请先载入算例。');
            const result = analyse(dataset, message.options);
            const buffers = new Set();
            const collect = value => {
                if (ArrayBuffer.isView(value)) buffers.add(value.buffer);
                else if (value && typeof value === 'object') Object.values(value).forEach(collect);
            };
            collect(result);
            self.postMessage({ id, result }, [...buffers]);
        } else throw new Error('未知的工具箱操作。');
    } catch (error) { self.postMessage({ id, error: error.message }); }
};
