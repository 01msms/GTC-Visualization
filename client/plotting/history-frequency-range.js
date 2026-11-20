/** Vertical extent of the two mode components within the visible time window. */
export function frequencyYRange(traces, [left, right]) {
    let min = Infinity;
    let max = -Infinity;
    for (const { x, y } of traces.slice(0, 2)) {
        for (let i = 0; i < x.length; i++) {
            if (x[i] < left) continue;
            if (x[i] > right) break;
            if (!Number.isFinite(y[i])) continue;
            min = Math.min(min, y[i]);
            max = Math.max(max, y[i]);
        }
    }
    if (min > max) return undefined;
    const pad = (max - min) * 0.05 || Math.abs(min) * 0.05 || 1;
    return [min - pad, max + pad];
}
