# Di 时空分析后端

`plot_Di_spatiotemporal.py` 来自 `Di_spatiotemporal_python`，由 GTC-Visualization 的“smiao 的工具箱”以无窗口模式调用。该网页入口支持 D_i、D_f、Gamma_i 和 Gamma_f，生成 PNG、PDF、SVG、NPZ、JSON。

依赖安装：

```bash
python -m pip install -r python-tools/di-spatiotemporal/requirements.txt
```

网页生成结果只写入 `public/toolbox-results/<任务 ID>/`，不会写回 GTC 算例目录。
