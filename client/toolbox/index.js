import { setupPlotTheme, reactThemedPlot } from '../shared/plot-theme.js';
import { createPlotConfig } from '../components/figure-data-download.js';
import { buildFigures, LABELS, unit } from './figures.js';

const $ = id => document.getElementById(id);
const form = $('toolbox-form'), status = $('toolbox-status'), errorBox = $('toolbox-error');
const worker = new Worker(new URL('./worker.js', import.meta.url));
const requests = new Map(), edits = new Map();
let nextRequest = 0, folders = [], selected = null, loaded = null, metadata = null;
let fetchController, poll, generation = 0, drawGeneration = 0, latest, numericalKey = '', activeEditKey = '', timer;
const graphs = new Map();

function request(type, payload, transfer = []) {
    const id = ++nextRequest;
    return new Promise((resolve, reject) => {
        requests.set(id, { resolve, reject }); worker.postMessage({ id, type, ...payload }, transfer);
    });
}
worker.onmessage = ({ data }) => {
    const req = requests.get(data.id); if (!req) return;
    requests.delete(data.id); if (data.error) req.reject(new Error(data.error)); else req.resolve(data.result);
};
worker.onerror = event => {
    const error = new Error(event.message || '浏览器计算进程启动失败，请刷新页面。');
    for (const req of requests.values()) req.reject(error);
    requests.clear(); showError(error);
};
function showError(error) { errorBox.textContent = error.message; errorBox.hidden = false; }
function setStatus(text, busy = false) { status.textContent = text; status.classList.toggle('is-busy', busy); }
const field = name => form.elements.namedItem(name);
function values() {
    return Object.fromEntries([...form.elements].filter(e => e.name && !['file', 'submit'].includes(e.type)).map(e => [e.name,
        e.type === 'checkbox' ? e.checked : e.type === 'number' ? (e.value === '' ? null : Number(e.value)) : e.value]));
}
const numericalNames = ['quantity', 'compare_kind', 'units', 'time_axis', 'r0', 'a', 'b0', 'tref_ev', 'nref_19', 'tstep', 'start', 'end', 'mean_rmin', 'mean_rmax', 'time_min', 'time_max', 'smooth_window', 'show_time_window', 'check_gradient', 'extra_di_gamma'];
function applyValues(settings) {
    for (const [name, value] of Object.entries(settings)) {
        const input = field(name);
        if (!input || input.type === 'file') continue;
        if (input.type === 'checkbox') input.checked = value === true;
        else input.value = value ?? '';
    }
    updateControls();
}

function updateControls() {
    const compare = field('quantity').value === 'compare', gamma = field('compare_kind').value === 'gamma';
    $('compare-controls').hidden = !compare; $('gamma-zero-control').hidden = !(compare && gamma);
    field('units').disabled = field('quantity').value.startsWith('gamma') || (compare && gamma);
    const view = field('view');
    view.querySelector('[value=i_single]').textContent = compare && gamma ? 'Γᵢ 独立时空图' : 'Dᵢ 独立时空图';
    view.querySelector('[value=f_single]').textContent = compare && gamma ? 'Γ𝒻 独立时空图' : 'D𝒻 独立时空图';
    for (const option of view.options) if (['i_single', 'f_single'].includes(option.value)) option.disabled = !compare;
    if (!compare && ['i_single', 'f_single'].includes(view.value)) view.value = 'combined';
    if (metadata) {
        field('quantity').querySelector('[value=df]').disabled = !metadata.hasFast;
        field('quantity').querySelector('[value=gammaf]').disabled = !metadata.hasFast || !metadata.hasProfile;
        field('quantity').querySelector('[value=compare]').disabled = !metadata.hasFast;
        field('compare_kind').querySelector('[value=gamma]').disabled = !metadata.hasProfile;
    }
}

function renderFolders() {
    const query = $('case-search').value.trim().toLowerCase();
    const matching = folders.filter(f => f.label.toLowerCase().includes(query));
    $('folder-count').textContent = `${matching.length} / ${folders.length} 个算例`;
    const list = $('toolbox-cases'); list.replaceChildren();
    for (const folder of matching) {
        const button = document.createElement('button'); button.type = 'button';
        button.className = 'toolbox-case'; button.textContent = folder.label; button.title = folder.label;
        button.setAttribute('aria-pressed', String(folder.value === selected?.value));
        if (folder.hasProfile) { const badge = document.createElement('small'); badge.textContent = 'profile.dat'; button.append(badge); }
        button.onclick = () => loadCase(folder);
        list.append(button);
    }
    if (!matching.length) {
        const p = document.createElement('p'); p.className = 'toolbox-note';
        p.textContent = folders.length ? '没有匹配的目录。' : '尚未找到 gtc.out 与 data1d.out 同时存在的算例。服务器初次扫描完成后可刷新目录。'; list.append(p);
    }
}
async function loadFolders(refresh = false) {
    $('refresh-folders').disabled = true;
    try {
        const response = await fetch(`/api/toolbox/folders${refresh ? '?refresh=1' : ''}`);
        const data = await response.json(); if (!response.ok) throw new Error(data.error);
        folders = data; renderFolders();
    } catch (error) { showError(error); }
    finally { $('refresh-folders').disabled = false; }
}
async function loadCase(folder, force = false) {
    if (loaded === folder.value && !force) return;
    const run = ++generation; ++drawGeneration;
    fetchController?.abort(); clearInterval(poll); selected = folder; metadata = null;
    latest = null; numericalKey = ''; loaded = null;
    $('toolbox-settings').disabled = true; $('reload-case').disabled = true;
    errorBox.hidden = true; $('load-progress').hidden = false; $('load-progress').removeAttribute('value');
    $('selected-path').textContent = folder.label; renderFolders();
    $('case-info').textContent = '正在读取算例…'; setStatus('读取算例数据…', true);
    $('toolbox-plots').hidden = true; $('toolbox-stats').hidden = true; $('toolbox-warnings').hidden = true;
    fetchController = new AbortController();
    const endpoint = `?folder=${encodeURIComponent(folder.value)}`;
    let polling = false;
    poll = setInterval(async () => {
        if (polling) return; polling = true;
        try {
            const p = await (await fetch(`/api/toolbox/status${endpoint}`, { signal: fetchController.signal })).json();
            if (run !== generation) return;
            if (p.phase === 'reading' && p.total) {
                $('load-progress').value = p.bytes / p.total;
                setStatus(`读取 ${Math.round(p.bytes / p.total * 100)}% · ${p.records} 条完整记录`, true);
            } else if (p.phase === 'preparing' || p.phase === 'ready') setStatus('整理数据并传输…', true);
        } catch (_) { /* The main request reports failures. */ }
        finally { polling = false; }
    }, 700);
    try {
        const start = performance.now();
        const response = await fetch(`/api/toolbox/data${endpoint}`, { signal: fetchController.signal });
        if (!response.ok) throw new Error((await response.json()).error);
        const buffer = await response.arrayBuffer(); if (run !== generation) return;
        const meta = await request('load', { buffer }, [buffer]); if (run !== generation) return;
        metadata = meta; loaded = folder.value;
        applyValues(meta.defaults);
        // The interval of a new case must never inherit physics from another case.
        for (const name of ['r0', 'a', 'b0', 'tref_ev', 'nref_19', 'tstep']) {
            field(name).title = Object.hasOwn(meta.inferred, name) ? '从 gtc.out 读取；可手动覆盖' : '原 Python 默认值；请核对算例参数';
            field(name).classList.toggle('is-fallback', !Object.hasOwn(meta.inferred, name));
        }
        if (!meta.hasFast && ['df', 'gammaf', 'compare'].includes(field('quantity').value)) field('quantity').value = 'di';
        $('toolbox-settings').disabled = false; updateControls();
        $('case-info').textContent = `${meta.records.toLocaleString()} 条记录 · ${meta.nr} 个径向点 · r/a ${meta.radius_range.map(v => v.toPrecision(5)).join('–')} · t ≤ ${meta.time_end.toPrecision(7)} R₀/Cₛ · 载入 ${((performance.now() - start) / 1000).toFixed(2)} s`;
        $('toolbox-empty').hidden = true;
        await draw();
    } catch (error) {
        if (run === generation && error.name !== 'AbortError') { showError(error); setStatus('读取失败，可重新载入。'); }
    } finally {
        if (run === generation) { clearInterval(poll); $('load-progress').hidden = true; $('reload-case').disabled = false; }
    }
}

function captureEdits() {
    if (!activeEditKey) return;
    const saved = edits.get(activeEditKey) || {};
    for (const [key, graph] of graphs) {
        if (!graph._toolAuto) continue;
        const edit = saved[key] || { titles: {}, names: {} };
        for (const [name, title] of Object.entries(graph._toolAuto.titles)) {
            const current = graph.layout[name]?.title?.text ?? (name === 'title' ? graph.layout.title?.text : undefined);
            if (current !== undefined && current !== title) edit.titles[name] = current;
        }
        graph.data.forEach((trace, i) => {
            const original = graph._toolAuto.names[i];
            if (original && trace.name !== original) edit.names[original] = trace.name;
            const title = trace.colorbar?.title?.text;
            if (title !== undefined && title !== graph._toolAuto.colorbars?.[original]) {
                (edit.colorbars ||= {})[original] = title;
            }
        });
        const sharedTitle = graph.layout.coloraxis?.colorbar?.title?.text;
        if (sharedTitle !== undefined && sharedTitle !== graph._toolAuto.colorbars?.shared) (edit.colorbars ||= {}).shared = sharedTitle;
        if (graph.layout.legend) edit.legend = { x: graph.layout.legend.x, y: graph.layout.legend.y };
        saved[key] = edit;
    }
    edits.set(activeEditKey, saved);
}

async function draw() {
    if (!metadata || !form.reportValidity()) return;
    const run = ++drawGeneration, loadRun = generation;
    const options = values();
    if (options.mean_ymin !== null && options.mean_ymax !== null && options.mean_ymin >= options.mean_ymax) { showError(new Error('平均曲线纵轴下限必须小于上限。')); return; }
    const core = Object.fromEntries(numericalNames.map(n => [n, options[n]]));
    const key = JSON.stringify(core); errorBox.hidden = true;
    setStatus('计算并更新图表…', true);
    const start = performance.now();
    try {
        if (!latest || key !== numericalKey) {
            const result = await request('analyse', { options: core });
            if (run !== drawGeneration || loadRun !== generation) return;
            latest = result; numericalKey = key;
        }
        captureEdits();
        activeEditKey = `${loaded}|${options.quantity}|${options.compare_kind}|${options.view}`;
        const figures = buildFigures(latest, { ...options, plot_width: $('toolbox-plots').parentElement.clientWidth }), editSet = edits.get(activeEditKey) || {};
        $('toolbox-plots').hidden = false;
        for (const [key, graph] of graphs) {
            if (!figures.some(f => f.key === key)) { Plotly.purge(graph); graph.parentElement.remove(); graphs.delete(key); }
        }
        for (const figure of figures) {
            if (run !== drawGeneration) return;
            let graph = graphs.get(figure.key);
            if (!graph) {
                const card = document.createElement('section'); card.className = 'toolbox-figure';
                graph = document.createElement('div'); graph.className = 'toolbox-chart'; graph.id = `toolbox-figure-${figure.key}`;
                card.append(graph); $('toolbox-plots').append(card); graphs.set(figure.key, graph);
            }
            const titles = { title: figure.layout.title.text };
            for (const [name, axis] of Object.entries(figure.layout)) if (/^[xy]axis\d*$/.test(name)) titles[name] = axis.title.text;
            const originalNames = figure.data.map(t => t.name), edit = editSet[figure.key];
            const colorbars = Object.fromEntries(figure.data.filter(t => t.colorbar).map(t => [t.name, t.colorbar.title.text]));
            if (figure.layout.coloraxis) colorbars.shared = figure.layout.coloraxis.colorbar.title.text;
            if (edit) {
                for (const [name, text] of Object.entries(edit.titles || {})) {
                    if (name === 'title') figure.layout.title.text = String(text);
                    else if (/^[xy]axis\d*$/.test(name) && figure.layout[name]) figure.layout[name].title.text = String(text);
                }
                for (const trace of figure.data) {
                    if (trace.colorbar && edit.colorbars?.[trace.name]) trace.colorbar.title.text = String(edit.colorbars[trace.name]);
                    if (edit.names?.[trace.name]) trace.name = String(edit.names[trace.name]);
                }
                if (figure.layout.coloraxis && edit.colorbars?.shared) figure.layout.coloraxis.colorbar.title.text = String(edit.colorbars.shared);
                if (edit.legend) Object.assign(figure.layout.legend, edit.legend);
            }
            await reactThemedPlot(graph, figure.data, figure.layout, createPlotConfig({
                responsive: true, displaylogo: false, scrollZoom: true,
                modeBarButtonsToRemove: $('toolbox-plots').parentElement.clientWidth < 520 ? ['zoomIn2d', 'zoomOut2d', 'autoScale2d'] : [],
                editable: true, edits: { axisTitleText: true, titleText: true, legendText: true, legendPosition: true,
                    colorbarTitleText: true, colorbarPosition: false, annotationPosition: false, shapePosition: false },
                toImageButtonOptions: { format: 'png', filename: `smiao-${options.quantity}-${figure.key}`, width: 1200, height: figure.layout.height, scale: 2 },
            }));
            graph._toolAuto = { titles, names: originalNames, colorbars };
        }
        if (run !== drawGeneration || loadRun !== generation) return;
        renderStats(latest);
        const warnings = [...latest.warnings]; if (metadata.profile_error) warnings.push(`profile.dat 未用于计算：${metadata.profile_error}`);
        $('toolbox-warnings').textContent = warnings.join('\n'); $('toolbox-warnings').hidden = !warnings.length;
        setStatus(`图表已更新 · ${((performance.now() - start) / 1000).toFixed(2)} s · 数据已缓存`);
    } catch (error) { if (run === drawGeneration) { showError(error); setStatus('请调整参数后重新绘图。'); } }
}
function renderStats(result) {
    const box = $('toolbox-stats'); box.replaceChildren(); box.hidden = false;
    for (const [q, series] of Object.entries(result.series)) {
        const card = document.createElement('div'); card.className = 'toolbox-stat';
        const label = document.createElement('span'); label.textContent = `⟨${LABELS[q]}⟩ 统计窗口平均`;
        const compareGamma = result.settings.quantity === 'compare' && result.settings.compare_kind === 'gamma';
        const number = document.createElement('strong'); number.textContent = (series.window_mean * (compareGamma && q === 'gammaf' ? 1000 : 1)).toExponential(5);
        const detail = document.createElement('small'); detail.textContent = `${unit(q, result.settings, compareGamma)} · SG 最大改变量 ${series.smooth_max_percent.toFixed(3)}%`;
        card.append(label, number, detail); box.append(card);
    }
    $('stats-detail').textContent = `统计记录 ${result.window.join('–')}（含端点）· 径向平均使用 ${result.mean_radial_point_count} 个网格点，实际 r/a ${result.mean_range_actual.map(v => v.toPrecision(6)).join('–')}。统计使用原始均值，平滑只影响显示。`;
}

form.onsubmit = event => {
    event.preventDefault(); clearTimeout(timer);
    draw().then(() => { if (window.innerWidth <= 900 && errorBox.hidden) $('toolbox-plots').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
};
form.addEventListener('change', event => {
    if (event.target.name === 'quantity') field('view').value = field('quantity').value === 'compare' ? 'maps' : 'combined';
    if (event.target.name === 'compare_kind' && field('compare_kind').value === 'gamma') field('view').value = 'means';
    updateControls();
    clearTimeout(timer);
    if (field('auto_redraw').checked && metadata) timer = setTimeout(draw, 180);
});
$('case-search').oninput = renderFolders;
$('refresh-folders').onclick = () => loadFolders(true);
$('reload-case').onclick = () => selected && loadCase(selected, true);
for (const tab of document.querySelectorAll('[data-toolbox-tab]')) tab.onclick = () => {
    for (const item of document.querySelectorAll('[data-toolbox-tab]')) item.setAttribute('aria-selected', String(item === tab));
    for (const panel of document.querySelectorAll('[data-toolbox-panel]')) panel.hidden = panel.dataset.toolboxPanel !== tab.dataset.toolboxTab;
};
$('reset-physics').onclick = () => {
    if (!metadata) return;
    for (const name of ['r0', 'a', 'b0', 'tref_ev', 'nref_19', 'tstep']) field(name).value = metadata.defaults[name] ?? '';
    draw();
};
$('reset-style').onclick = () => { edits.delete(activeEditKey); for (const graph of graphs.values()) graph._toolAuto = null; draw(); };
function downloadSettings() {
    captureEdits();
    const blob = new Blob([JSON.stringify({ version: 1, case: selected?.label, options: values(), currentEdits: edits.get(activeEditKey), edits: Object.fromEntries(edits) }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = 'smiao-toolbox-settings.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('save-settings').onclick = downloadSettings;
$('import-settings').onclick = () => $('settings-file').click();
$('settings-file').onchange = async event => {
    try {
        const file = event.target.files[0]; if (!file) return;
        if (file.size > 2 * 1024 * 1024) throw new Error('设置文件超过 2 MB。');
        const data = JSON.parse(await file.text()); if (data.version !== 1 || !data.options) throw new Error('设置文件格式无效。');
        applyValues(data.options);
        for (const [key, value] of Object.entries(data.edits || {})) edits.set(key, value);
        const o = values();
        if (data.currentEdits) edits.set(`${loaded}|${o.quantity}|${o.compare_kind}|${o.view}`, data.currentEdits);
        for (const graph of graphs.values()) graph._toolAuto = null;
        draw();
    } catch (error) { showError(error); }
    finally { event.target.value = ''; }
};
setupPlotTheme(); loadFolders();
window.addEventListener('resize', () => { clearTimeout(timer); timer = setTimeout(() => metadata && field('auto_redraw').checked && draw(), 250); });
