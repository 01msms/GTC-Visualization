'use strict';

const LABELS = { di: 'Dᵢ', df: 'D𝒻', gamma: 'Γᵢ', gammaf: 'Γ𝒻' };
const COLORS = { di: '#2479b2', df: '#d9534f', gamma: '#2479b2', gammaf: '#d9534f' };
const BLUE_RED = [[0, '#2166ac'], [0.25, '#92c5de'], [0.5, '#f7f7f7'], [0.75, '#f4a582'], [1, '#b2182b']];
const palettes = { gtc: BLUE_RED, soft_bwr: [[0, '#7777ed'], [0.5, '#ffffff'], [1, '#ef7777']], bwr: [[0, '#0000ff'], [0.5, '#fff'], [1, '#ff0000']], jet: 'Jet', viridis: 'Viridis' };
const maxAbs = values => { let m = 0; for (const v of values) m = Math.max(m, Math.abs(v)); return m; };
const unit = (q, s, compare) => q.startsWith('gamma') ? (q === 'gammaf' && compare ? '10¹⁶ m⁻² s⁻¹' : '10¹⁹ m⁻² s⁻¹') : s.units === 'si' ? 'm²/s' : 'T_ref/(eB₀)';
const axis = (title, extra = {}) => ({ title: { text: title }, zeroline: true, tickformat: '.4g', automargin: true, ...extra });
const baseLayout = title => ({ title: { text: title, x: 0.5 }, autosize: true, margin: { t: 64, b: 65, l: 80, r: 110 },
    legend: { orientation: 'h', y: -0.12, x: 0 }, hovermode: 'closest' });

function rowsLayout(count, title, xlabel, range, fontSize) {
    const layout = baseLayout(title), gap = count > 1 ? 0.12 : 0;
    const height = (1 - gap * (count - 1)) / count;
    const rows = [];
    for (let i = 0; i < count; i++) {
        const suffix = i ? String(i + 1) : '';
        const x = `x${suffix}`, y = `y${suffix}`, bottom = 1 - (i + 1) * height - i * gap;
        layout[`xaxis${suffix}`] = axis(i === count - 1 ? xlabel : '', { range, anchor: y, showticklabels: i === count - 1, ...(i ? { matches: 'x' } : {}) });
        layout[`yaxis${suffix}`] = axis('', { domain: [Math.max(0, bottom), bottom + height], anchor: x });
        rows.push({ x, y, suffix, domain: layout[`yaxis${suffix}`].domain });
    }
    layout.font = { family: 'Arial, sans-serif', size: fontSize || 14 };
    layout.height = count === 1 ? 470 : count === 2 ? 700 : 960;
    return { layout, rows };
}

function windowShapes(result, row) {
    const scale = result.settings.time_axis === 'physical' ? result.settings.tstep : 1;
    const [x0, x1] = result.window.map(t => t * scale);
    return [
        { type: 'rect', xref: row.x, yref: `${row.y} domain`, x0, x1, y0: 0, y1: 1, fillcolor: 'rgba(36,121,178,0.08)', line: { width: 0 }, layer: 'above' },
        ...[x0, x1].map(x => ({ type: 'line', xref: row.x, yref: `${row.y} domain`, x0: x, x1: x, y0: 0, y1: 1, line: { color: '#7c9aa5', width: 1, dash: 'dash' } })),
    ];
}

function independentBound(values) {
    const sorted = Float64Array.from(values, Math.abs).sort();
    const index = (sorted.length - 1) * 0.8, lo = Math.floor(index), f = index - lo;
    return sorted[lo] * (1 - f) + sorted[Math.min(lo + 1, sorted.length - 1)] * f || sorted[sorted.length - 1] || 1;
}

function curveTraces(result, q, row, style, compare) {
    const series = result.series[q], scale = compare && q === 'gammaf' ? 1000 : 1;
    const traces = [], x = Array.from(result.time), smooth = result.settings.smooth_window > 1;
    const add = (values, kind, color) => {
        const prefix = kind === 'raw' ? 'raw' : 'smooth';
        const interval = Math.max(1, Number(style[`${prefix}_markevery`]) || 1);
        const marker = style[`${prefix}_marker`] || 'none';
        const trace = { type: 'scatter', mode: marker === 'none' ? 'lines' : 'lines+markers', x,
            y: Array.from(values, v => v * scale), xaxis: row.x, yaxis: row.y,
            name: `${LABELS[q]}${smooth ? (kind === 'raw' ? ' Raw' : ' Smoothed') : ''}`,
            line: { color, width: Number(style.line_width) || 1.8, dash: style[`${prefix}_dash`] || 'solid' },
            marker: { color, symbol: marker === 'none' ? 'circle' : marker, size: Array.from({ length: x.length }, (_, i) => i % interval === 0 ? 5 : 0) },
            hovertemplate: `%{x:.6g}<br>${LABELS[q]}: %{y:.6g} ${unit(q, result.settings, compare)}<extra>%{fullData.name}</extra>` };
        if (marker === 'none') delete trace.marker;
        traces.push(trace);
    };
    if (style.show_raw !== false) add(series.mean, 'raw', smooth && !compare ? style.raw_color || '#a6b1bd' : COLORS[q]);
    if (smooth && style.show_smooth !== false) add(series.smooth, 'smooth', compare ? COLORS[q] : style.smooth_color || '#2479b2');
    if (!smooth && style.show_raw === false && style.show_smooth !== false) add(series.mean, 'smooth', COLORS[q]);
    return traces;
}

function buildFigures(result, style = {}) {
    const s = result.settings, compare = s.quantity === 'compare';
    const qs = compare ? (s.compare_kind === 'gamma' ? ['gamma', 'gammaf'] : ['di', 'df']) : [s.quantity];
    const view = style.view || (compare ? 'maps' : 'combined');
    const single = view === 'i_single' || view === 'f_single';
    const mapQuantities = view === 'means' ? [] : single ? [qs[view === 'i_single' ? 0 : qs.length - 1]] : qs;
    const wantMeans = view === 'means' || view === 'combined';
    if (wantMeans && style.show_raw === false && style.show_smooth === false) throw new Error('至少显示 Raw 或 Smoothed 中的一种曲线。');
    const xlabel = s.time_axis === 'physical' ? 't (R₀/Cₛ)' : 'Diagnostic record';
    const { layout, rows } = rowsLayout(mapQuantities.length + (wantMeans ? 1 : 0),
        compare ? `${LABELS[qs[0]]} / ${LABELS[qs[1]]}` : LABELS[qs[0]], xlabel, result.time_range, style.font_size);
    const data = [], annotations = [];
    layout.title.font = { size: Number(style.title_size) || 20 };
    layout.legend.font = { size: Number(style.legend_size) || 12 };
    const sharedColor = compare && s.compare_kind === 'diffusion' && !single && mapQuantities.length > 1;
    const commonBound = sharedColor ? Math.max(...qs.map(q => maxAbs(result.series[q].values))) || 1 : null;
    if (sharedColor) layout.coloraxis = { colorscale: palettes[style.cmap] || BLUE_RED,
        cmin: -(style.color_limit_i || commonBound), cmax: style.color_limit_i || commonBound,
        colorbar: { title: { text: unit(qs[0], s, compare) }, thickness: 15, tickformat: '.3g',
            y: (rows[0].domain[1] + rows[mapQuantities.length - 1].domain[0]) / 2,
            len: rows[0].domain[1] - rows[mapQuantities.length - 1].domain[0] } };
    mapQuantities.forEach((q, i) => {
        const row = rows[i], scale = compare && q === 'gammaf' ? 1000 : 1;
        const values = result.series[q].values;
        const bound = Number(style[q === qs[1] ? 'color_limit_f' : 'color_limit_i']) || (single && !q.startsWith('gamma') ? independentBound(values) : maxAbs(values) || 1) * scale;
        const z = Array.from({ length: result.nr }, (_, r) => Array.from({ length: result.records }, (_, t) => values[t * result.nr + r] * scale));
        const trace = { type: 'heatmap', x: Array.from(result.time), y: Array.from(result.radius_a), z,
            xaxis: row.x, yaxis: row.y, name: LABELS[q], zsmooth: false,
            hovertemplate: `t=%{x:.6g}<br>r/a=%{y:.6g}<br>${LABELS[q]}=%{z:.6g}<extra></extra>` };
        if (sharedColor) trace.coloraxis = 'coloraxis';
        else Object.assign(trace, { zmin: -bound, zmax: bound, colorscale: palettes[style.cmap] || BLUE_RED,
            colorbar: { title: { text: unit(q, s, compare) }, thickness: 15, tickformat: '.3g', y: (row.domain[0] + row.domain[1]) / 2, len: row.domain[1] - row.domain[0] } });
        data.push(trace);
        layout[`yaxis${row.suffix}`].title.text = 'r/a';
        annotations.push({ text: `${LABELS[q]}(r,t)`, x: 0, y: row.domain[1], yshift: 12, xref: 'paper', yref: 'paper', showarrow: false, xanchor: 'left' });
    });
    if (wantMeans) {
        const row = rows[rows.length - 1];
        const dual = compare && s.compare_kind === 'gamma';
        qs.forEach((q, i) => {
            const target = dual && i ? { ...row, y: `y${rows.length + 1}` } : row;
            data.push(...curveTraces(result, q, target, style, compare));
        });
        const meanAxis = layout[`yaxis${row.suffix}`];
        meanAxis.title.text = `${compare && !dual ? '⟨Dᵢ⟩ / ⟨D𝒻⟩' : `⟨${LABELS[qs[0]]}⟩`} (${unit(qs[0], s, compare)})`;
        if (style.mean_ymin != null || style.mean_ymax != null) meanAxis.range = [style.mean_ymin, style.mean_ymax];
        if (dual) {
            const second = `yaxis${rows.length + 1}`;
            layout[second] = axis(`⟨Γ𝒻⟩ (${unit('gammaf', s, true)})`, { overlaying: row.y, side: 'right', anchor: row.x, showgrid: false });
            if (style.align_gamma_zero) {
                const bounds = qs.map((q, i) => {
                    let b = Math.max(maxAbs(result.series[q].mean), maxAbs(result.series[q].smooth)) * (i ? 1000 : 1);
                    if (!i) b = Math.max(b, Math.abs(style.mean_ymin || 0), Math.abs(style.mean_ymax || 0));
                    return b * 1.07 || 1;
                });
                meanAxis.range = [-bounds[0], bounds[0]]; layout[second].range = [-bounds[1], bounds[1]];
            }
        }
    }
    layout.annotations = annotations;
    layout.shapes = s.show_time_window ? rows.flatMap(row => windowShapes(result, row)) : [];
    layout.uirevision = `${s.quantity}:${s.compare_kind}:${view}:${result.time_range.join(',')}:${s.units}`;
    layout.meta = { settings: s, statistics: Object.fromEntries(qs.map(q => [q, { window_mean: result.series[q].window_mean }])), radial_range: result.mean_range_actual, window: result.window };
    if (style.plot_width && style.plot_width < 520) {
        layout.margin = { l: 55, r: compare && s.compare_kind === 'gamma' ? 55 : 70, t: 82, b: 100 };
        layout.title.y = 1 - 50 / layout.height;
        layout.title.yanchor = 'middle';
        layout.font.size = Number(style.font_size) || 11;
        layout.legend.font.size = Number(style.legend_size) || 10;
        layout.legend.y = -0.27;
        for (const [name, value] of Object.entries(layout)) {
            if (/^[xy]axis\d*$/.test(name)) value.title.standoff = 2;
        }
    }
    const figures = [{ key: 'main', data, layout }];
    if (s.extra_di_gamma) {
        for (const q of ['di', 'gamma']) {
            if (s.quantity === q) continue;
            const extra = buildFigures({ ...result, settings: { ...s, quantity: q, extra_di_gamma: false, check_gradient: false } }, { ...style, view: 'combined' })[0];
            extra.key = q; figures.push(extra);
        }
    }
    if (s.check_gradient) figures.push(gradientFigure(result, style));
    return figures;
}

function gradientFigure(result, style) {
    const di = result.series.di.mean, gamma = result.series.gamma.mean;
    const si = result.settings.units === 'si' ? 1 : result.settings.tref_ev / result.settings.b0;
    let numerator = 0, denominator = 0;
    for (let t = 0; t < di.length; t++) { numerator += di[t] * si * gamma[t]; denominator += (di[t] * si) ** 2; }
    const fit = denominator ? numerator / denominator : 0, peak = maxAbs(gamma);
    const fitted = Array.from(di, v => v * si * fit), residual = Array.from(gamma, (v, i) => peak ? (v - fitted[i]) / peak * 100 : 0);
    const layout = baseLayout('密度梯度与通量核对'), data = [];
    layout.height = 710; layout.font = { size: Number(style.font_size) || 14 };
    const panels = [
        { title: '平衡离子密度', x: result.radius_a, y: Array.from(result.profiles.ni_si, n => n / 1e19), xlabel: 'r/a', ylabel: 'nᵢ (10¹⁹ m⁻³)' },
        { title: '局部密度梯度', x: result.radius_a, y: Array.from(result.profiles.grad_ni_si, n => -n / 1e19), xlabel: 'r/a', ylabel: '−dnᵢ/dr (10¹⁹ m⁻⁴)' },
        { title: '通量与常数缩放对比', x: result.time, y: Array.from(gamma), xlabel: 't', ylabel: 'Γᵢ (10¹⁹ m⁻²s⁻¹)' },
        { title: '常数缩放后的残差', x: result.time, y: residual, xlabel: 't', ylabel: 'Residual / peak (%)' },
    ];
    layout.annotations = [];
    panels.forEach((p, i) => {
        const suffix = i ? i + 1 : '', x = `x${suffix}`, y = `y${suffix}`;
        const xd = i % 2 ? [0.59, 1] : [0, 0.41], yd = i < 2 ? [0.6, 1] : [0, 0.4];
        layout[`xaxis${suffix}`] = axis(p.xlabel, { domain: xd, anchor: y });
        layout[`yaxis${suffix}`] = axis(p.ylabel, { domain: yd, anchor: x });
        data.push({ type: 'scatter', mode: 'lines', x: Array.from(p.x), y: p.y, xaxis: x, yaxis: y, name: p.title, line: { color: '#2479b2' }, showlegend: false });
        layout.annotations.push({ text: p.title, x: xd[0], y: yd[1], yshift: 15, xanchor: 'left', xref: 'paper', yref: 'paper', showarrow: false });
    });
    data.push({ type: 'scatter', mode: 'lines', x: Array.from(result.time), y: fitted, xaxis: 'x3', yaxis: 'y3', name: 'G_fit × ⟨Dᵢ SI⟩', line: { color: '#d9534f', dash: 'dash' }, showlegend: true });
    layout.meta = { fitted_gradient_m4: fit * 1e19, max_residual_percent: maxAbs(residual) };
    return { key: 'gradient', data, layout };
}

export { buildFigures, gradientFigure, LABELS, unit };
