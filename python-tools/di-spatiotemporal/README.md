# Di 时空分析 Python 参考代码

`plot_Di_spatiotemporal.py` 来自 `Di_spatiotemporal_python`，在本仓库中保留用于开发时核对 JavaScript 移植的计算结果。生产工具箱使用 `shared/spatiotemporal.js`，发布包排除此目录。

只有重新生成 Python 基准或做真实数据对照时才需要安装参考环境依赖：

```bash
python -m pip install -r python-tools/di-spatiotemporal/requirements.txt
```

在仓库根目录执行：

```bash
python util/generate-toolbox-reference.py
node util/check-toolbox-parity.js /path/to/a/GTC-output
```

完整迁移说明见根目录 `TOOLBOX_JS_MIGRATION.md`。
