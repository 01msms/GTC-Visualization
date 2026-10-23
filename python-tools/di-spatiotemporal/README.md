# Di 时空分析后端

`plot_Di_spatiotemporal.py` 来自 `Di_spatiotemporal_python`，由 GTC-Visualization 的“smiao 的工具箱”以无窗口模式调用。该网页入口支持 D_i、D_f、Gamma_i 和 Gamma_f，生成 PNG、PDF、SVG、NPZ、JSON。

依赖安装：

```bash
python -m pip install -r python-tools/di-spatiotemporal/requirements.txt
```

离线服务器可使用发布压缩包内的 `wheelhouse/`：

```bash
python -m pip install --no-index --find-links python-tools/di-spatiotemporal/wheelhouse -r python-tools/di-spatiotemporal/requirements.txt
```

该 wheelhouse 必须按服务器的操作系统、CPU 架构和 Python ABI 生成；安装脚本会先用 wheelhouse 更新 pip，再离线安装依赖。压缩包不包含 Python 解释器。

网页生成结果只写入 `public/toolbox-results/<任务 ID>/`，不会写回 GTC 算例目录。
