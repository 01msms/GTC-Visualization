const { spawn } = require('child_process');
const { once } = require('events');
const { chmod, cp, lstat, mkdtemp, mkdir, readdir, rm } = require('fs/promises');
const { tmpdir } = require('os');
const path = require('path');

const packName = 'GTC-Visualization.tar.gz';
const fileList = [
    'public/fonts',
    'public/input',
    'public/javascripts',
    'public/libs',
    'public/shader',
    'public/stylesheets',
    'python-tools/di-spatiotemporal',
    'public/favicon.ico',
    'public/loading.gif',
    'views',
    '.env_example',
    'install-python-tools.sh',
    'LICENSE',
    'package.json',
    'README.md',
    'server-prod.js',
    'server-prod.js.LICENSE.txt',
];

async function normalizePermissions(target) {
    const stat = await lstat(target);
    // Do not chmod a symlink's target outside the staging directory.
    if (stat.isSymbolicLink()) return;
    await chmod(target, stat.isDirectory() ? 0o755 : 0o644);
    if (stat.isDirectory()) {
        for (const entry of await readdir(target)) {
            await normalizePermissions(path.join(target, entry));
        }
    }
}

async function pack(
    sourceRoot = process.cwd(),
    archivePath = path.join(sourceRoot, packName)
) {
    const stagingRoot = await mkdtemp(
        path.join(tmpdir(), 'gtc-visualization-pack-')
    );
    const packageRoot = path.join(stagingRoot, 'GTC-Visualization');

    try {
        // Keep a stable archive root name regardless of the checkout folder.
        // Normalize permissions on this isolated copy so read-only source
        // attributes never leak into the release or get changed in-place.
        await mkdir(packageRoot);
        for (const filename of fileList) {
            await cp(
                path.join(sourceRoot, filename),
                path.join(packageRoot, filename),
                { recursive: true }
            );
        }
        const pythonWheelhouse = path.join(
            sourceRoot,
            'python-tools/di-spatiotemporal/wheelhouse'
        );
        try {
            await lstat(pythonWheelhouse);
            await cp(
                pythonWheelhouse,
                path.join(packageRoot, 'python-tools/di-spatiotemporal/wheelhouse'),
                { recursive: true }
            );
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
        }
        // Copies can inherit Windows read-only attributes. Clear them only on
        // the staged tree, leaving source permissions untouched.
        await normalizePermissions(packageRoot);

        const tar = spawn(
            'tar',
            [
                '--format=ustar',
                '-czf',
                archivePath,
                '-C',
                stagingRoot,
                'GTC-Visualization',
            ],
            { stdio: 'inherit' }
        );
        const [code] = await once(tar, 'close');
        if (code !== 0) {
            throw new Error(`tar exited with code ${code}`);
        }
    } finally {
        await rm(stagingRoot, { recursive: true, force: true });
    }
}

if (require.main === module) {
    pack()
        .then(() => {
            console.log(`Files are packed into ${packName}`);
        })
        .catch(err => {
            console.error(err);
            process.exitCode = 1;
        });
}

module.exports = { pack, fileList };
