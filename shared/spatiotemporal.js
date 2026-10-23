'use strict';

// Numerical contract follows Di_spatiotemporal_python. Arrays are Float64,
// time-major; display smoothing never changes matrices or window statistics.
const DEFAULTS = Object.freeze({
    r0: 1.89, a: 0.433, b0: 2.44, tref_ev: 1090, tstep: 0.04,
    nref_19: null, start: 1600, end: 2000, units: 'normalized',
    time_axis: 'physical', quantity: 'di', compare_kind: 'diffusion',
    mean_rmin: null, mean_rmax: null, time_min: null, time_max: null,
    smooth_window: 1, show_time_window: true,
});
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?$/;
function numeric(token) {
    if (!NUMBER.test(token)) throw new Error(`无法解析数值：${token.slice(0, 40)}`);
    const value = Number(token.replace(/[dD]/g, 'e'));
    if (!Number.isFinite(value)) throw new Error('数据包含非有限数值。');
    return value;
}
function increasing(values) {
    return values.every((v, i) => Number.isFinite(v) && (i === 0 || v > values[i - 1]));
}

function parseGtc(text) {
    text = text.replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/);
    const markers = lines.flatMap((line, i) => line.includes('Key profiles on radial mesh:') ? [i] : []);
    if (markers.length !== 1) throw new Error('gtc.out 应包含唯一的 Key profiles 数据块。');
    const rows = [];
    let columns = [];
    for (const line of lines.slice(markers[0] + 1)) {
        const tokens = line.trim().split(/\s+/);
        if (!line.trim()) continue;
        if (!tokens.every(t => NUMBER.test(t))) {
            if (rows.length) break;
            const names = line.toLowerCase().replace(/,/g, ' ').trim().split(/\s+/);
            if (['i', 'index', 'ir'].includes(names[0])) columns = names;
            continue;
        }
        if (tokens.length < 8) { if (rows.length) break; else continue; }
        rows.push(tokens.map(numeric));
    }
    if (rows.length < 2 || rows.some(row => row.length !== rows[0].length)) {
        throw new Error('gtc.out 剖面表需要至少两行且每行列数相同。');
    }
    if (rows.some((r, i) => !Number.isInteger(r[0]) || (i > 0 && r[0] !== rows[i - 1][0] + 1))) {
        throw new Error('gtc.out 剖面表索引不连续。');
    }
    const radius = Float64Array.from(rows, r => r[1]);
    if (radius[0] < 0 || !increasing(radius)) throw new Error('r/R₀ 必须非负且严格递增。');
    const candidates = columns.flatMap((c, i) => ['meshni', 'ni', 'n_i'].includes(c) ? [i] : []);
    const fallback = !columns.length && [8, 10].includes(rows[0].length);
    const niCol = candidates.length === 1 ? candidates[0] : fallback ? (rows[0].length === 8 ? 7 : 8) : -1;
    if (niCol < 0 || niCol >= rows[0].length) throw new Error('无法唯一识别 meshni/ni/n_i 离子密度列。');
    const ni = Float64Array.from(rows, r => r[niCol]);
    if (ni.some(v => v < 0) || !ni.some(v => v > 0)) throw new Error('离子密度必须非负且不能全为零。');
    const num = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eEdD][+-]?\\d+)?';
    const last = pattern => {
        const matches = [...text.matchAll(new RegExp(pattern, 'gim'))];
        return matches.length ? numeric(matches[matches.length - 1][1]) : null;
    };
    const assignment = name => last(`^\\s*${name}\\s*=\\s*(${num})`);
    const r0 = assignment('R0'), b0 = assignment('B0'), tref = assignment('ETEMP0');
    const eden = assignment('EDEN0'), dt = assignment('TSTEP'), ndiag = assignment('NDIAG');
    const aOverR0 = last(`at last closed flux surface\\s+a_minor\\s*=\\s*(${num})`);
    const inferred = {};
    if (r0 !== null) inferred.r0 = r0 / 100;
    if (b0 !== null) inferred.b0 = b0 / 10000;
    if (tref !== null) inferred.tref_ev = tref;
    if (aOverR0 !== null && r0 !== null) inferred.a = aOverR0 * inferred.r0;
    if (dt !== null && ndiag !== null) inferred.tstep = dt * ndiag;
    if (eden !== null && /density profiles normalized to on-axis electron value/i.test(text)) inferred.nref_19 = eden * 1e-13;
    return {
        radius_r0: radius, ni_norm: ni, psi: Float64Array.from(rows, r => r[2]), inferred,
        parameters: {
            solver_tstep: dt, ndiag, profile_psiw: last(`^\\s*more eqdata:\\s*ped,psiw,rmaj=\\s*${num}\\s+(${num})`),
            fast_electron_load: assignment('FELOAD'), fast_ion_load: assignment('FLOAD'),
            ion_density_column_1based: niCol + 1, column_names: columns,
        },
        warnings: fallback ? ['gtc.out 缺少剖面列名，按原 MATLAB 的 8/10 列格式定位 ni，请核对。'] : [],
    };
}

function parseProfile(text) {
    const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    const names = lines.shift().trim().toLowerCase().split(/\s+/);
    if (names.filter(n => n === 'pol-flux').length !== 1 || names.filter(n => n === 'nf').length !== 1) {
        throw new Error('profile.dat 必须包含唯一的 pol-flux 和 nf 列。');
    }
    const values = lines.join(' ').trim().split(/\s+/).map(numeric);
    if (values.length < names.length * 2 || values.length % names.length) throw new Error('profile.dat 数值行不完整。');
    const count = values.length / names.length;
    const psi = Float64Array.from({ length: count }, (_, i) => values[i * names.length + names.indexOf('pol-flux')]);
    const nf = Float64Array.from({ length: count }, (_, i) => values[i * names.length + names.indexOf('nf')]);
    if (psi[0] < 0 || !increasing(psi)) throw new Error('profile.dat 极向磁通必须非负、严格递增。');
    if (nf.some(v => v < 0) || !nf.some(v => v > 0)) throw new Error('profile.dat 的 nf 必须非负且不能全为零。');
    return { profile_psi: psi, profile_nf_cm3: nf };
}

function gradient(values, radius) {
    if (values.length !== radius.length || radius.length < 2 || !increasing(radius)) throw new Error('密度梯度需要严格递增且长度匹配的半径。');
    return Float64Array.from(values, (_, i) => {
        const left = Math.max(0, i - 1), right = Math.min(values.length - 1, i + 1);
        return (values[right] - values[left]) / (radius[right] - radius[left]);
    });
}

function interpolate(x, y, target) {
    if (!increasing(x) || y.length !== x.length || target[0] < x[0] || target[target.length - 1] > x[x.length - 1]) {
        throw new Error('插值坐标无效或超出原网格范围；不会外推密度。');
    }
    let i = 0;
    return Float64Array.from(target, t => {
        while (i < x.length - 2 && t > x[i + 1]) i++;
        return y[i] + (y[i + 1] - y[i]) * ((t - x[i]) / (x[i + 1] - x[i]));
    });
}

function resample(matrix, records, from, to) {
    if (from === to) return matrix;
    const out = new Float64Array(records * to);
    for (let t = 0; t < records; t++) {
        for (let r = 0; r < to; r++) {
            const position = r * (from - 1) / (to - 1);
            const i = Math.min(Math.floor(position), from - 2), fraction = position - i;
            out[t * to + r] = matrix[t * from + i] * (1 - fraction) + matrix[t * from + i + 1] * fraction;
        }
    }
    return out;
}

function createDataset(raw, gtc, profile = {}) {
    const nr = gtc.radius_r0.length;
    const warnings = [...gtc.warnings];
    if (nr !== raw.nr) warnings.push(`径向点数 ${raw.nr} → ${nr}，按 Python/MATLAB 的归一化索引线性插值。`);
    if (raw.ignored_trailing_values) warnings.push(`末尾 ${raw.ignored_trailing_values} 个数不足一帧，已忽略。`);
    return {
        ...gtc, ...profile, nr, records: raw.records, header: raw.header,
        di: resample(raw.di, raw.records, raw.nr, nr),
        ...(raw.df ? { df: resample(raw.df, raw.records, raw.nr, nr) } : {}),
        source_radial_points: raw.nr, ignored_trailing_values: raw.ignored_trailing_values || 0, warnings,
    };
}

// Quadratic Savitzky–Golay with scipy mode='interp': use the nearest full
// window at the two edges and evaluate its least-squares quadratic there.
function smoothTrace(values, window) {
    if (!Number.isInteger(window) || window < 1 || window % 2 !== 1 || window > values.length) {
        throw new Error(`平滑窗口必须为不超过 ${values.length} 的正奇数。`);
    }
    if (window === 1) return Float64Array.from(values);
    const half = (window - 1) / 2;
    let s2 = 0, s4 = 0;
    for (let x = -half; x <= half; x++) { s2 += x * x; s4 += x ** 4; }
    const determinant = window * s4 - s2 * s2;
    const weights = Float64Array.from({ length: window }, (_, j) => (s4 - s2 * (j - half) ** 2) / determinant);
    const out = new Float64Array(values.length);
    for (let i = half; i < values.length - half; i++) {
        let sum = 0;
        for (let j = 0; j < window; j++) sum += values[i - half + j] * weights[j];
        out[i] = sum;
    }
    for (const [side, start] of [0, values.length - window].entries()) {
        let sy = 0, sxy = 0, sx2y = 0;
        for (let j = 0; j < window; j++) {
            const x = j - half, y = values[start + j];
            sy += y; sxy += x * y; sx2y += x * x * y;
        }
        const a = (sy * s4 - sx2y * s2) / determinant;
        const b = sxy / s2, c = (window * sx2y - s2 * sy) / determinant;
        const indices = side === 0 ? [0, half] : [window - half, window];
        for (let j = indices[0]; j < indices[1]; j++) {
            const x = j - half;
            out[start + j] = a + b * x + c * x * x;
        }
    }
    return out;
}

function analyse(dataset, options = {}) {
    const settings = { ...DEFAULTS, ...dataset.inferred };
    for (const [name, value] of Object.entries(options)) {
        if (value !== '' && value !== undefined && value !== null) settings[name] = value;
    }
    for (const name of ['r0', 'a', 'b0', 'tref_ev', 'tstep']) {
        if (!Number.isFinite(settings[name]) || settings[name] <= 0) throw new Error(`${name} 必须为正的有限数值。`);
    }
    const { records: nt, nr } = dataset;
    if (!['di', 'df', 'gamma', 'gammaf', 'compare'].includes(settings.quantity) || !['diffusion', 'gamma'].includes(settings.compare_kind)) throw new Error('物理量无效。');
    if (!['normalized', 'si'].includes(settings.units) || !['physical', 'step'].includes(settings.time_axis)) throw new Error('单位或时间轴无效。');
    if (settings.nref_19 !== null && (!Number.isFinite(settings.nref_19) || settings.nref_19 <= 0)) throw new Error('参考密度必须为正数。');
    if (!Number.isInteger(settings.start) || !Number.isInteger(settings.end) || settings.start < 1 || settings.end < settings.start || settings.start > nt) throw new Error(`统计窗口需要 1 ≤ 起点 ≤ 终点，起点不能超过 ${nt} 条记录。`);
    const warnings = [...dataset.warnings];
    const end = Math.min(nt, settings.end);
    if (end !== settings.end) warnings.push(`统计终点 ${settings.end} 已收至最后一条完整记录 ${end}。`);
    const radius_m = Float64Array.from(dataset.radius_r0, r => r * settings.r0);
    const radius_a = Float64Array.from(radius_m, r => r / settings.a);
    const lo = settings.mean_rmin ?? radius_a[0], hi = settings.mean_rmax ?? radius_a[nr - 1];
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < radius_a[0] - 1e-10 || hi > radius_a[nr - 1] + 1e-10 || lo >= hi) throw new Error(`径向平均范围需要位于 ${radius_a[0].toPrecision(6)}–${radius_a[nr - 1].toPrecision(6)} r/a 内，且下限小于上限。`);
    const selected = Array.from({ length: nr }, (_, i) => i).filter(i => radius_a[i] >= lo - 1e-10 && radius_a[i] <= hi + 1e-10);
    const weightSum = selected.reduce((sum, i) => sum + radius_m[i], 0);
    if (!selected.length || weightSum <= 0) throw new Error('径向范围中没有有效网格点或 r 权重总和不大于零。');
    const weights = new Float64Array(nr);
    for (const i of selected) weights[i] = radius_m[i] / weightSum;
    const physical_time = Float64Array.from({ length: nt }, (_, i) => (i + 1) * settings.tstep);
    const tolerance = Math.max(settings.tstep * 1e-3, Math.abs(physical_time[nt - 1]) * 1e-10);
    let tlo = settings.time_min ?? physical_time[0], thi = settings.time_max ?? physical_time[nt - 1];
    if (!Number.isFinite(tlo) || !Number.isFinite(thi) || tlo < 0 || thi < 0 || tlo > physical_time[nt - 1] + tolerance || thi > physical_time[nt - 1] + tolerance) throw new Error(`时间范围需位于 0–${physical_time[nt - 1].toPrecision(8)} R₀/Cₛ 内。`);
    tlo = Math.min(tlo, physical_time[nt - 1]); thi = Math.min(thi, physical_time[nt - 1]);
    if (tlo >= thi || !physical_time.some(t => t >= tlo - tolerance && t <= thi + tolerance)) throw new Error('时间显示范围中没有诊断记录。');
    const requested = settings.quantity === 'compare' ? (settings.compare_kind === 'gamma' ? ['gamma', 'gammaf'] : ['di', 'df']) : [settings.quantity];
    if (settings.check_gradient || settings.extra_di_gamma) for (const q of ['di', 'gamma']) if (!requested.includes(q)) requested.push(q);
    const profiles = {};
    if (settings.nref_19 !== null) {
        profiles.ni_si = Float64Array.from(dataset.ni_norm, v => v * settings.nref_19 * 1e19);
        profiles.grad_ni_si = gradient(profiles.ni_si, radius_m);
    }
    if (requested.includes('gammaf')) {
        if (dataset.profile_error) throw new Error(dataset.profile_error);
        if (!dataset.profile_psi) throw new Error('Γ_f 需要同算例的 profile.dat。');
        if (dataset.parameters.fast_electron_load !== null && dataset.parameters.fast_electron_load !== 0) throw new Error('FELOAD 非零，不能把 profile.dat 的 nf 当作快离子密度。');
        const psiw = dataset.parameters.profile_psiw;
        if (!Number.isFinite(psiw) || psiw <= 0 || !increasing(dataset.psi)) throw new Error('Γ_f 需要有效 psiw 和严格递增的 GTC 极向磁通。');
        const aligned = Float64Array.from(dataset.profile_psi, p => p * psiw / dataset.profile_psi[dataset.profile_psi.length - 1]);
        profiles.nf_si = Float64Array.from(interpolate(aligned, dataset.profile_nf_cm3, dataset.psi), n => n * 1e6);
        profiles.grad_nf_si = gradient(profiles.nf_si, radius_m);
    }
    const series = {};
    for (const q of requested) {
        const fast = q === 'df' || q === 'gammaf', flux = q.startsWith('gamma');
        const source = fast ? dataset.df : dataset.di;
        if (!source) throw new Error('D_f / Γ_f 需要 data1d.out 的第三物种。');
        const grad = fast ? profiles.grad_nf_si : profiles.grad_ni_si;
        if (flux && !grad) throw new Error('Γ_i 需要参考密度，请在物理参数中填写或检查 gtc.out 的 EDEN0。');
        const factor = settings.tref_ev / settings.b0;
        const values = new Float64Array(nt * nr), mean = new Float64Array(nt), profile = new Float64Array(nr);
        let windowMean = 0;
        for (let t = 0; t < nt; t++) {
            let sum = 0;
            for (let r = 0; r < nr; r++) {
                const value = source[t * nr + r] * (flux ? -factor * grad[r] / 1e19 : settings.units === 'si' ? factor : 1);
                if (!Number.isFinite(value)) throw new Error('单位换算结果溢出，请检查物理参数。');
                values[t * nr + r] = value; sum += value * weights[r];
                if (t >= settings.start - 1 && t < end) profile[r] += value / (end - settings.start + 1);
            }
            mean[t] = sum;
            if (t >= settings.start - 1 && t < end) windowMean += sum / (end - settings.start + 1);
        }
        const smooth = smoothTrace(mean, settings.smooth_window);
        let peak = 0, change = 0, squares = 0;
        for (let i = 0; i < nt; i++) { peak = Math.max(peak, Math.abs(mean[i])); change = Math.max(change, Math.abs(smooth[i] - mean[i])); squares += (smooth[i] - mean[i]) ** 2; }
        series[q] = { values, mean, smooth, window_mean: windowMean, window_profile_mean: profile,
            smooth_max_percent: peak ? change / peak * 100 : 0, smooth_rms_percent: peak ? Math.sqrt(squares / nt) / peak * 100 : 0 };
    }
    return {
        settings, records: nt, nr, series, profiles, radius_m, radius_a, weights, physical_time,
        time: settings.time_axis === 'physical' ? physical_time : Float64Array.from({ length: nt }, (_, i) => i + 1),
        time_range: settings.time_axis === 'physical' ? [tlo, thi] : [tlo / settings.tstep, thi / settings.tstep],
        window: [settings.start, end], mean_range_actual: [radius_a[selected[0]], radius_a[selected[selected.length - 1]]],
        mean_radial_point_count: selected.length, warnings,
    };
}

module.exports = { DEFAULTS, numeric, parseGtc, parseProfile, gradient, interpolate, resample, createDataset, smoothTrace, analyse };
