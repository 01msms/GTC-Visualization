'use strict';

const pug = require('pug');
const { createCaseStore } = require('./toolbox/case-store');

module.exports = function registerToolbox(app, { getOutputFolders, refreshOutputFolders, viewPath, store = createCaseStore() }) {
    const outputFolder = req => {
        const folder = getOutputFolders().find(f => f.value === req.query.folder);
        if (!folder) { const error = new Error('算例未找到，请刷新目录后重新选择。'); error.status = 404; throw error; }
        return folder;
    };
    app.get('/toolbox', (req, res) => res.send(pug.renderFile(viewPath)));
    app.get('/api/toolbox/folders', async (req, res) => {
        try {
            if (req.query.refresh === '1' && refreshOutputFolders) await refreshOutputFolders();
            res.json(getOutputFolders().map(({ value, label, hasProfile }) => ({ value, label, hasProfile })));
        }
        catch (error) { res.status(500).json({ error: error.message }); }
    });
    app.get('/api/toolbox/status', (req, res) => {
        try { res.json(store.status(outputFolder(req).directory)); }
        catch (error) { res.status(error.status || 400).json({ error: error.message }); }
    });
    app.get('/api/toolbox/data', async (req, res) => {
        try {
            const entry = await store.load(outputFolder(req));
            res.set('Cache-Control', 'private, no-store'); res.type('application/octet-stream');
            res.vary('Accept-Encoding');
            if (req.acceptsEncodings('gzip')) { res.set('Content-Encoding', 'gzip'); res.send(entry.zipped); }
            else res.send(entry.payload);
        } catch (error) {
            res.status(error.status || 400).json({ error: error.code === 'ENOENT' ? '算例文件已删除或正在移动，请刷新目录。' : error.message });
        }
    });
};
