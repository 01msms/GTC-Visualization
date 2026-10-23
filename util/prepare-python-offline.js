const { spawnSync } = require('child_process');
const { mkdir, rm } = require('fs/promises');
const path = require('path');

const root = path.resolve(__dirname, '..');
const wheelhouse = path.join(
    root,
    'python-tools',
    'di-spatiotemporal',
    'wheelhouse'
);
const isWindows = process.platform === 'win32';
const defaultPython = isWindows ? 'python' : 'python3';
const python = process.env.PYTHON_EXECUTABLE || defaultPython;
const args = [
    '-m',
    'pip',
    'download',
    '--only-binary=:all:',
    '--dest',
    wheelhouse,
    'pip==24.3.1',
];

const target = {
    platform: process.env.PYTHON_TARGET_PLATFORM,
    version: process.env.PYTHON_TARGET_VERSION,
    implementation: process.env.PYTHON_TARGET_IMPLEMENTATION,
    abi: process.env.PYTHON_TARGET_ABI,
};
const targetOptions = Object.values(target).some(Boolean);

if (targetOptions && Object.values(target).some(value => !value)) {
    console.error(
        'Cross-platform wheel downloads require PYTHON_TARGET_PLATFORM, ' +
            'PYTHON_TARGET_VERSION, PYTHON_TARGET_IMPLEMENTATION and PYTHON_TARGET_ABI.'
    );
    process.exit(1);
}

if (targetOptions) {
    args.push(
        '--platform',
        target.platform,
        '--python-version',
        target.version,
        '--implementation',
        target.implementation,
        '--abi',
        target.abi
    );
}

args.push('-r', path.join(root, 'python-tools', 'di-spatiotemporal', 'requirements.txt'));
async function main() {
    await rm(wheelhouse, { recursive: true, force: true });
    await mkdir(wheelhouse, { recursive: true });
    const result = spawnSync(python, args, { cwd: root, stdio: 'inherit' });

    if (result.error) {
        console.error(`Could not start Python (${python}): ${result.error.message}`);
        process.exitCode = 1;
        return;
    }
    if (result.status !== 0) {
        process.exitCode = result.status || 1;
        return;
    }

    console.log(`Offline Python wheels prepared in ${wheelhouse}`);
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
