'use strict';

const { randomUUID } = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const pug = require('pug');

const ALLOWED_QUANTITIES = new Map([
    ['di', 'D_i'],
    ['gamma', 'Γ_i'],
    ['df', 'D_f'],
    ['gammaf', 'Γ_f'],
]);
const MAX_PROCESS_OUTPUT = 1024 * 1024;
const PROCESS_TIMEOUT_MS = 15 * 60 * 1000;

function optionalNumber(value, label) {
    if (value === undefined || value === '') return undefined;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) {
        throw new Error(`${label} 必须是非负有限数值，或留空。`);
    }
    return number;
}

function optionalPositiveInteger(value, label) {
    if (value === undefined || value === '') return undefined;
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1) {
        throw new Error(`${label} 必须是正整数，或留空。`);
    }
    return number;
}

function appendBounded(previous, chunk) {
    return (previous + chunk.toString()).slice(-MAX_PROCESS_OUTPUT);
}

function runPython(executable, script, args, cwd) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, [script, ...args], {
            cwd,
            windowsHide: true,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            callback(value);
        };
        const timer = setTimeout(() => {
            child.kill();
            finish(
                reject,
                new Error('Python 计算超过 15 分钟，已停止本次任务。')
            );
        }, PROCESS_TIMEOUT_MS);

        child.stdout.on('data', chunk => {
            stdout = appendBounded(stdout, chunk);
        });
        child.stderr.on('data', chunk => {
            stderr = appendBounded(stderr, chunk);
        });
        child.once('error', error => finish(reject, error));
        child.once('close', code => {
            if (code === 0) {
                finish(resolve, { stdout, stderr });
                return;
            }
            const detail = (stderr || stdout).trim();
            finish(
                reject,
                new Error(
                    detail || `Python 计算进程以状态 ${code} 退出。`
                )
            );
        });
    });
}

async function listFiles(directory, prefix = '') {
    const files = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const relative = path.join(prefix, entry.name);
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await listFiles(absolute, relative)));
        } else if (entry.isFile()) {
            files.push(relative);
        }
    }
    return files;
}

async function removeExpiredResults(resultsDirectory) {
    const expirationTime = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let entries;
    try {
        entries = await fs.readdir(resultsDirectory, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const outputDirectory = path.join(resultsDirectory, entry.name);
        const details = await fs.stat(outputDirectory);
        if (details.mtimeMs < expirationTime) {
            await fs.rm(outputDirectory, { recursive: true, force: true });
        }
    }
}

function resultUrl(jobId, relativePath) {
    const encodedPath = relativePath
        .split(path.sep)
        .map(part => encodeURIComponent(part))
        .join('/');
    return `/toolbox-results/${jobId}/${encodedPath}`;
}

module.exports = function registerDiSpatiotemporalToolbox(
    app,
    {
        getOutputFolders,
        pythonExecutable,
        pythonScript,
        pythonCwd,
        resultsDirectory,
        viewPath,
    }
) {
    function render(res, { form, error, result } = {}) {
        res.send(
            pug.renderFile(viewPath, {
                outputs: getOutputFolders(),
                form: form || {},
                error,
                result,
            })
        );
    }

    app.get('/toolbox', (req, res) => render(res));

    app.post('/toolbox', async (req, res) => {
        const form = {
            output_folder: String(req.body.output_folder || '.'),
            quantity: String(req.body.quantity || 'di'),
            units: String(req.body.units || 'normalized'),
            mean_rmin: String(req.body.mean_rmin || ''),
            mean_rmax: String(req.body.mean_rmax || ''),
            time_min: String(req.body.time_min || ''),
            time_max: String(req.body.time_max || ''),
            smooth_window: String(req.body.smooth_window || '1'),
            start: String(req.body.start || ''),
            end: String(req.body.end || ''),
        };
        let outputDirectory;

        try {
            const selectedFolder = getOutputFolders().find(
                folder => folder.value === form.output_folder
            );
            if (!selectedFolder) {
                throw new Error('请选择已扫描到的 GTC 算例目录。');
            }
            if (!ALLOWED_QUANTITIES.has(form.quantity)) {
                throw new Error('请选择有效的物理量。');
            }
            if (!['normalized', 'si'].includes(form.units)) {
                throw new Error('请选择有效的扩散系数单位。');
            }
            if (form.quantity === 'gammaf' && !selectedFolder.hasProfile) {
                throw new Error('Γ_f 计算需要该算例目录中的 profile.dat。');
            }

            const smoothWindow = Number(form.smooth_window);
            if (
                !Number.isInteger(smoothWindow) ||
                smoothWindow < 1 ||
                smoothWindow > 501 ||
                smoothWindow % 2 !== 1
            ) {
                throw new Error('平滑窗口必须是 1 到 501 之间的正奇数。');
            }

            const meanRmin = optionalNumber(form.mean_rmin, '径向下限');
            const meanRmax = optionalNumber(form.mean_rmax, '径向上限');
            const timeMin = optionalNumber(form.time_min, '时间起点');
            const timeMax = optionalNumber(form.time_max, '时间终点');
            const start = optionalPositiveInteger(form.start, '统计起始记录');
            const end = optionalPositiveInteger(form.end, '统计结束记录');
            if (meanRmin !== undefined && meanRmax !== undefined && meanRmin >= meanRmax) {
                throw new Error('径向下限必须小于上限。');
            }
            if (timeMin !== undefined && timeMax !== undefined && timeMin >= timeMax) {
                throw new Error('时间起点必须小于终点。');
            }
            if (start !== undefined && end !== undefined && start > end) {
                throw new Error('统计起始记录不能大于结束记录。');
            }

            const args = [
                '--data',
                selectedFolder.dataPath,
                '--gtc',
                selectedFolder.gtcPath,
                '--quantity',
                form.quantity,
                '--units',
                form.units,
                '--time-axis',
                'physical',
                '--smooth-window',
                String(smoothWindow),
                '--no-show',
            ];
            if (form.quantity === 'gammaf') {
                args.push('--profile', selectedFolder.profilePath);
            }
            for (const [flag, value] of [
                ['--mean-rmin', meanRmin],
                ['--mean-rmax', meanRmax],
                ['--time-min', timeMin],
                ['--time-max', timeMax],
                ['--start', start],
                ['--end', end],
            ]) {
                if (value !== undefined) args.push(flag, String(value));
            }

            const jobId = randomUUID();
            outputDirectory = path.join(resultsDirectory, jobId);
            await removeExpiredResults(resultsDirectory);
            await fs.mkdir(outputDirectory, { recursive: true });
            await runPython(
                pythonExecutable,
                pythonScript,
                [...args, '--out-dir', outputDirectory],
                pythonCwd
            );

            const files = (await listFiles(outputDirectory)).filter(file =>
                /\.(png|pdf|svg|npz|json)$/i.test(file)
            );
            const preview = files.find(file => /_preview\.png$/i.test(file));
            if (!preview) {
                throw new Error('Python 已运行，但没有生成预览图片。');
            }

            const relativeOutput = selectedFolder.value === '.'
                ? path.basename(selectedFolder.directory)
                : selectedFolder.value;
            render(res, {
                form,
                result: {
                    folderLabel: relativeOutput,
                    quantityLabel: ALLOWED_QUANTITIES.get(form.quantity),
                    previewUrl: resultUrl(jobId, preview),
                    files: files.map(file => ({
                        label: path.basename(file),
                        url: resultUrl(jobId, file),
                    })),
                },
            });
        } catch (error) {
            if (outputDirectory) {
                await fs.rm(outputDirectory, { recursive: true, force: true });
            }
            render(res, {
                form,
                error: error.message.slice(0, 5000),
            });
        }
    });
};
