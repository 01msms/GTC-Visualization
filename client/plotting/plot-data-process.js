'use strict';

// Snapshot functions (snapshotSpectrum, snapshotPoloidalPreview,
// snapshotPoloidal, drawPoloidalDataPlotly, drawPoloidalDataWebGL,
// buildShaderProgram, createColorMap, packTextureArgs, getTicks,
// getRationalSurface) have moved to snapshot.js

import state from '../control/state.js';
import { themedPlot } from '../shared/plot-theme.js';
import { createPlotConfig } from '../components/figure-data-download.js';
import { getFFT } from '../shared/fft.js';
import { interleave } from '../shared/util.js';
import { frequencyYRange } from './history-frequency-range.js';

export async function historyMode(figures, interval1 = null, interval2 = null) {
    // `interval1`/`interval2` are user-selected zoom ranges (as fractions of
    // the total data length) coming from the rangesliders. When they are
    // null (i.e. the initial call) we fall back to the conventional
    // measurement window [0.43, 0.98]. Frequency follows the growth window
    // until the user chooses a separate frequency range.
    const measure1 = interval1 ?? [0.43, 0.98];
    const measure2 = interval2 ?? measure1;

    // deconstructing figures
    let [componentsFig, growthFig, freqFig, spectralFig] = figures;

    // growth rate figure
    let { gamma, measurePts } = cal_gamma(
        growthFig.data[0].y,
        state.timeStep,
        measure1
    );
    growthFig.data[1] = {
        x: [measurePts[0].x, measurePts[1].x],
        y: [measurePts[0].y, measurePts[1].y],
        type: 'scatter',
        line: { dash: 'dot', color: 'rgb(245, 10, 10)', width: 3 },
        markers: { color: 'rgb(255, 0, 0)', size: 8 },
    };
    growthFig.layout.title.text = `$\\gamma=${gamma.toPrecision(5)}$`;
    {
        // Pin the default x range to the data extent (or to the user-selected
        // zoom when recalculating). Without this Plotly's autorange together
        // with the rangeslider pads the visible range beyond the last data
        // point. The interval->absolute conversion mirrors the absolute->
        // interval conversion done in addHistoryRecal (divide by `len`).
        const xs = growthFig.data[0].x;
        const len = xs[xs.length - 1];
        growthFig.layout.xaxis.range = interval1
            ? [interval1[0] * len, interval1[1] * len]
            : [xs[0], len];
        growthFig.layout.xaxis.autorange = false;
    }
    growthFig.layout.xaxis.rangeslider = {
        bgcolor: 'rgb(200,200,210)',
    };

    // frequency figure
    let y0 = componentsFig.data[0].y[0];
    y0 = y0 == 0 ? 1 : y0;
    let yReals = componentsFig.data[0].y.map(
        (y, i) => y / (Math.exp(gamma * (i + 1) * state.timeStep) * y0)
    );
    let yImages = componentsFig.data[1].y.map(
        (y, i) => y / (Math.exp(gamma * (i + 1) * state.timeStep) * y0)
    );
    let omega;
    ({ omega, measurePts } = cal_omega_r(
        yReals,
        yImages,
        state.timeStep,
        measure2
    ));
    freqFig.data[0] = {
        x: [...Array(yReals.length).keys()].map(i => (i + 1) * state.timeStep),
        y: yReals,
        type: 'scatter',
        mode: 'lines',
    };
    freqFig.data[1] = {
        x: [...Array(yReals.length).keys()].map(i => (i + 1) * state.timeStep),
        y: yImages,
        type: 'scatter',
        mode: 'lines',
    };
    if (Number.isFinite(omega)) {
        freqFig.data[2] = {
            x: [measurePts[0].x, measurePts[1].x],
            y: [measurePts[0].y, measurePts[1].y],
            type: 'scatter',
            line: { dash: 'dot', color: 'rgb(245, 10, 10)', width: 3 },
            mode: 'lines+markers',
            marker: { color: 'rgb(255, 0, 0)', size: 8 },
        };
    } else {
        freqFig.data.length = 2;
    }
    const omegaText = Number.isFinite(omega) ? omega.toPrecision(5) : 'unavailable';
    freqFig.layout.title.text = Number.isFinite(omega)
        ? `$\\omega=${omegaText}$`
        : 'ω unavailable (fewer than two peaks)';
    {
        const xs = freqFig.data[0].x;
        const len = xs[xs.length - 1];
        const visible = measure2.map(fraction => fraction * len);
        freqFig.layout.xaxis.range = visible;
        freqFig.layout.xaxis.autorange = false;
        const range = frequencyYRange(freqFig.data, visible);
        freqFig.layout.yaxis.range = range;
        freqFig.layout.yaxis.autorange = !range;
    }
    freqFig.layout.xaxis.rangeslider = {
        bgcolor: 'rgb(200,200,210)',
        yaxis: { rangemode: 'auto' },
    };

    // spectral figure
    let powerSpectrum = await cal_spectrum(
        yReals,
        yImages,
        state.timeStep,
        measure2
    );
    spectralFig.data[0] = Object.assign(powerSpectrum, {
        type: 'scatter',
        mode: 'lines',
    });

    if (navigator.clipboard) {
        await navigator.clipboard.writeText(
            `${gamma.toPrecision(5)}, ${omegaText}`
        );
    }
}
export async function trackingPlot(figures) {
    const zeta = figures.pop().extraData;

    const figureDiv1 = document.getElementById('figure-1');
    await themedPlot.newPlot(
        figureDiv1,
        figures[0].data,
        figures[0].layout,
        createPlotConfig({ editable: true })
    );

    // Plotly will do the spline for me
    const [carpet, scatter] = figureDiv1.calcdata;

    Object.assign(figures[1].data[0], {
        x: scatter.map(({ x }, i) => x * Math.cos(zeta[i])),
        y: scatter.map(({ x }, i) => x * Math.sin(zeta[i])),
        z: scatter.map(({ y }) => y),
    });

    themedPlot.newPlot(
        'figure-2',
        figures[1].data,
        figures[1].layout,
        createPlotConfig({ editable: true })
    );
}

export function addSimulationRegion(fig) {
    const [rg0, rg1] = state.basicParameters.radial_region;
    const rgd =
        rg0 +
        (state.basicParameters.diag_flux / state.basicParameters.mpsi) *
            (rg1 - rg0);
    const data = fig.data[0].y;

    let y_min = Infinity,
        y_max = -Infinity;
    data.forEach(y => {
        if (y_min > y) {
            y_min = y;
        }
        if (y_max < y) {
            y_max = y;
        }
    });
    if (y_min == y_max) {
        y_max = y_min + 1;
    }

    const extendRegion = (x0, x1, s) => {
        return [x0 - s * (x1 - x0), x1 + s * (x1 - x0)];
    };

    const sep_props = {
        y: extendRegion(y_min, y_max, 0.2),
        mode: 'lines',
        line: {
            color: 'rgb(225, 156, 36)',
            width: 3,
        },
        showlegend: true,
    };
    fig.data.forEach(d => (d.showlegend = false));
    fig.data.push(
        // simulation region border
        {
            x: [rg0, rg0],
            ...sep_props,
            showlegend: false,
        },
        {
            name: 'Simulation Region',
            x: [rg1, rg1],
            fill: 'tonextx',
            ...sep_props,
        },
        // diagnostic flux
        {
            name: 'Diagnostic Flux',
            x: [rgd, rgd],
            ...sep_props,
            line: {
                color: 'rgb(143, 177, 49)',
                width: 2,
            },
        }
    );

    fig.layout.yaxis.range = extendRegion(y_min, y_max, 0.1);
}

/**
 * Fit the logarithmic phi-RMS history over the selected time interval.
 * The fourth History phi-RMS figure already contains ln(phi RMS), so its
 * slope against time is the growth rate directly.
 *
 * @param {HTMLElement} figure - The logarithmic phi-RMS figure.
 * @param {[number, number]|null} interval - Fractional data interval selected
 * from the x-axis range slider.
 */
export function historyPhiRms(
    figure,
    interval = null,
    baseTitle = figure?.layout?.title?.text ?? ''
) {
    const trace = figure?.data?.[0];
    const xs = trace?.x;
    const ys = trace?.y;
    if (!xs?.length || !ys?.length || xs.length !== ys.length) {
        return;
    }

    const measure = interval ?? [0.43, 0.98];
    const lastDataIndex = ys.length - 1;
    const startIndex = Math.max(
        0,
        Math.min(lastDataIndex, Math.floor(measure[0] * ys.length))
    );
    const endIndex = Math.max(
        startIndex,
        Math.min(lastDataIndex, Math.floor(measure[1] * ys.length))
    );
    const selected = [];
    for (let i = startIndex; i <= endIndex; i++) {
        // JSON serializes non-finite values as null; Number(null) would turn
        // missing coordinates into zero and corrupt the growth-rate fit.
        if (
            xs[i] != null &&
            ys[i] != null &&
            Number.isFinite(Number(xs[i])) &&
            Number.isFinite(Number(ys[i]))
        ) {
            selected.push(i);
        }
    }

    const first = selected[0];
    const last = selected[selected.length - 1];
    const elapsed = Number(xs[last]) - Number(xs[first]);
    const gamma =
        selected.length >= 2 && elapsed !== 0
            ? (Number(ys[last]) - Number(ys[first])) / elapsed
            : Number.NaN;

    if (Number.isFinite(gamma)) {
        figure.data[1] = {
            x: [xs[first], xs[last]],
            y: [ys[first], ys[last]],
            type: 'scatter',
            mode: 'lines+markers',
            name: 'Growth rate fit',
            line: { dash: 'dot', color: 'rgb(245, 10, 10)', width: 3 },
            marker: { color: 'rgb(255, 0, 0)', size: 8 },
        };
    } else {
        figure.data.length = 1;
    }

    // Plotly renders only the first MathJax expression in a title. Keep
    // the original label and gamma inside one expression so both appear.
    const gammaText = Number.isFinite(gamma)
        ? gamma.toPrecision(5)
        : '\\text{unavailable}';
    const title = baseTitle.trim();
    figure.layout.title.text = title.startsWith('$') && title.endsWith('$')
        ? `${title.slice(0, -1)}\\qquad\\gamma=${gammaText}$`
        : `${title} — γ = ${Number.isFinite(gamma) ? gammaText : 'unavailable'}`;

    const rangeStart = interval ? xs[startIndex] : xs[0];
    const rangeEnd = interval ? xs[endIndex] : xs[xs.length - 1];
    figure.layout.xaxis.range = [rangeStart, rangeEnd];
    figure.layout.xaxis.autorange = false;
    figure.layout.xaxis.rangeslider = {
        bgcolor: 'rgb(200,200,210)',
    };
}

/**
 * Calculate the growth rate of the time series array
 *
 * @param {Array<Number>} ys a series of data
 * @param {number} dt time step
 * @param {Array<Number>} interval
 *
 * @returns {{gamma: number, measurePts:{x:number, y:number}[]}}} growth rate
 */
export function cal_gamma(ys, dt, interval) {
    const [tIniIndex, tEndIndex] = sampleBounds(ys.length, interval);

    let gamma =
        (Math.log(ys[tEndIndex]) - Math.log(ys[tIniIndex])) /
        ((tEndIndex - tIniIndex) * dt);

    let p1 = { x: (tIniIndex + 1) * dt, y: ys[tIniIndex] };
    let p2 = { x: (tEndIndex + 1) * dt, y: ys[tEndIndex] };

    return {
        gamma: gamma,
        measurePts: [p1, p2],
    };
}

// Inclusive sample indices. Sample i is at (i + 1) * dt.
function sampleBounds(length, [start, end]) {
    const tolerance = 4 * Number.EPSILON * length;
    return [
        Math.max(0, Math.ceil(start * length - tolerance) - 1),
        Math.min(length - 1, Math.floor(end * length + tolerance) - 1),
    ];
}

/**
 * Calculate the frequency of the array
 *
 * @param {Array<Number>} yReals
 * @param {number} dt time step
 * @param {Array<Number>} interval
 *
 * @returns {{omega:number, measurePts:{x:number, y:number}[]}}
 */
export function cal_omega_r(yReals, yImages, dt, interval) {
    const [tIniIndex, tEndIndex] = sampleBounds(yReals.length, interval);

    const findMaximuns = ys => {
        const maximums = [];
        const section = [];
        for (let i = tIniIndex + 1; i < tEndIndex; ++i) {
            section.push((ys[i - 1] + ys[i] + ys[i + 1]) / 3);
        }
        section.forEach((y, i, arr) => {
            if (
                i > 0 &&
                i < arr.length - 1 &&
                y > arr[i - 1] &&
                (y > arr[i + 1] ||
                    (y === arr[i + 1] && y > arr[i + 2]))
            ) {
                // Interpolate a peak between samples, including a peak
                // centered halfway between two equal adjacent samples.
                const leftDrop = y - arr[i - 1];
                const rightDrop = y - arr[i + 1];
                const offset = 0.5 * (leftDrop - rightDrop) / (leftDrop + rightDrop);
                maximums.push([i + tIniIndex + 1 + offset, y]);
            }
        });
        return maximums;
    };

    const realMaximums = findMaximuns(yReals);
    const imagMaximums = findMaximuns(yImages);

    const maximums =
        realMaximums.length > imagMaximums.length ? realMaximums : imagMaximums;

    let omega;
    let periodNum = maximums.length - 1;
    let p1 = { x: null, y: null };
    let p2 = { x: null, y: null };
    if (periodNum < 1) {
        omega = Number.NaN;
    } else {
        p1.x = (maximums[0][0] + 1) * dt;
        p1.y = maximums[0][1];
        p2.x = (maximums[maximums.length - 1][0] + 1) * dt;
        p2.y = maximums[maximums.length - 1][1];
        omega = (2 * Math.PI * periodNum) / (p2.x - p1.x);
    }

    return {
        omega: omega,
        measurePts: [p1, p2],
    };
}

/**
 * Calculate power spectrum, asynchronously
 *
 * @param {Array<Number>} reals
 * @param {Array<Number>} images
 * @param {number} timeStep
 *
 * @returns {{x: Array<Number>, y: Array<Number>}} power spectrum
 */
export async function cal_spectrum(reals, images, timeStep, interval) {
    const [t_ini, last] = sampleBounds(reals.length, interval);
    const t_end = last + 1;
    const len = t_end - t_ini;
    if (len < 2) return { x: [], y: [] };
    const halfLen = Math.floor(len / 2);

    const fft = await getFFT();
    const transformed = fft.c2c1d(
        interleave(
            reals.slice(t_ini, t_end),
            images.slice(t_ini, t_end)
        )
    );
    const spectrum = Array.from({ length: len }, (_, index) => {
        const real = transformed[index * 2];
        const imaginary = transformed[index * 2 + 1];
        return Math.sqrt(real * real + imaginary * imaginary);
    });

    return {
        x: [...Array(len).keys()].map(
            i => ((2 * Math.PI) / (len * timeStep)) * (i - halfLen)
        ),
        y: Array.from(spectrum.slice(len - halfLen)).concat(
            Array.from(spectrum.slice(0, len - halfLen))
        ),
    };
}
