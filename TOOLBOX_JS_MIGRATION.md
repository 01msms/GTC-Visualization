# smiao 工具箱 JavaScript 迁移说明

## 使用流程

首页进入“smiao 的工具箱”，搜索并点击算例。目录名称在列表和当前路径栏均可完整换行显示。首次选中时读取 `data1d.out`、`gtc.out` 和可选的 `profile.dat`，之后在同一页面调整参数会复用已载入数据。

左侧三个页签分别负责：

- **分析**：物理量、物种对比、版式、单位、时间轴、径向平均范围、时间显示范围、统计窗口、Savitzky–Golay 平滑、窗口标记、梯度核对，以及同时查看 D_i/Gamma_i。
- **物理参数**：自动读取并可覆盖 R0、a、B0、T_ref、n_ref、诊断时间间隔；自动值缺失时标记 Python 原程序的备用值。Gamma_i 缺少参考密度时明确提示填写。
- **图形**：配色、对称色标上下界、均值图纵轴、Gamma 双轴零点对齐、Raw/Smoothed 可见性、颜色、线型、标记及其间隔、字号和线宽。

修改参数后默认自动重画，也可关闭自动重画后点击“重新绘图”。缩放、平移、图例隐藏/显示沿用 Plotly。双击标题、坐标轴标题、色标标题或图例可改文字，图例可拖动。文字编辑按算例和版式保留在当前页面；通过“保存设置 / 导入设置”可带到后续会话。

图片和当前图表数据使用右上角原项目的工具栏下载。图片保存当前预览及文字编辑；CSV/JSON 保存当前绘制的数据。仅在点击下载时导出，不在每次预览时创建高分辨率图片和压缩数据文件。此版本不生成原 Python 的 PDF/NPZ 文件集合。

## 与原 Python 功能的对应

| 原程序能力 | 网页实现 |
| --- | --- |
| D_i / D_f / Gamma_i / Gamma_f | 四种单物理量，时空图和平均曲线 |
| D_i / D_f 对比 | 两热图共色标、平均曲线、合并图、各物种独立热图 |
| Gamma_i / Gamma_f 对比 | 独立色标、双轴平均曲线、合并图及单独热图；左轴 10¹⁹，右轴 10¹⁶ m⁻²s⁻¹ |
| 径向平均和窗口统计 | r 加权，记录号从 1 开始且包含两端；实际网格范围与窗口均值在图外显示 |
| 时间显示范围和单位 | 时间范围始终按 R0/Cs 输入，切换记录号轴时换算显示 |
| Savitzky–Golay 平滑 | 二阶、边界 interp；只改显示曲线 |
| Raw/Smoothed 样式 | 显示开关、颜色、线型、标记、间隔 |
| 自动/手动物理参数 | gtc.out 自动读取和覆盖，恢复自动参数 |
| 标题、轴标题、色标、图例编辑 | 图中直接编辑；设置文件可保存与导入 |
| 同时保存 D_i 和 Gamma_i | 同时查看两张单图，每张使用自身工具栏保存 |
| 梯度核对 | 密度、局部梯度、常数缩放对照和相对残差四面板 |
| Tk 数据缓存与原位重画 | Node 解析缓存 + 浏览器 Web Worker 原始数据缓存 + Plotly.react |

## 计算规则

1. `data1d.out` 头部七个数保持原规则。第一物种首通道为 D_i，第三物种首通道为 D_f。时间点数由完整诊断帧计算；末尾不完整的一帧忽略并提示。文件头第一个数不再乘入时间轴。
2. 径向网格和离子密度来自 `gtc.out` 的唯一 `Key profiles` 表，优先按 `meshni/ni/n_i` 列名识别离子密度。8/10 列无表头兼容模式发出提示。
3. data1d 与剖面径向点数不同时，沿归一化网格索引线性插值，和原 Python/MATLAB 一致。
4. 扩散系数的 SI 转换为 `D_SI = D_normalized * T_ref[eV] / B0[T]`。Gamma 始终从 SI 的 D 计算，切换显示单位不会重复转换通量。
5. Gamma_i 使用 `n_i = meshni * nref_19 * 10^19`。Gamma_f 使用 profile 的 `nf`（cm⁻³ → m⁻³），先按 `psiw` 缩放极向磁通，再插值到 GTC 网格；不按 profile 的 r 列计算梯度，不外推密度，FELOAD 非零时拒绝当作快离子密度。
6. 非均匀网格梯度复现 MATLAB：内点使用跨两点差商，边界使用单边差商。`Gamma(t,r) = -D_SI(t,r) * dn/dr`，保留符号，先局部换算再平均。
7. 平均使用现有网格中心和 `sum(value*r)/sum(r)`；不引入磁面 Jacobian，不额外乘径向网格间隔。统计窗口及原始均值不会受平滑或显示范围影响。
8. 二阶 Savitzky–Golay 使用与 SciPy `mode='interp'` 等价的端部拟合。热图矩阵保持完整，未抽样或平滑。

## 文件与数据流

```mermaid
flowchart LR
    A[服务器扫描目录] --> B[工具箱算例列表]
    B --> C[Node 流式读 data1d 和剖面]
    C --> D[Float64 二进制传输]
    D --> E[浏览器 Worker 缓存与计算]
    E --> F[Plotly 交互绘图]
    F --> G[按需保存图片或数据]
```

| 文件 | 职责 |
| --- | --- |
| `shared/spatiotemporal.js` | GTC/profile 解析、网格插值、梯度、单位、通量、范围、统计和平滑 |
| `server/toolbox/case-store.js` | 流式读 data1d，保留需要的物种通道，缓存解析结果，gzip 二进制传输 |
| `shared/spatiotemporal-wire.js` | 解析对齐的 Float64 传输协议 |
| `server/di-spatiotemporal-toolbox.js` | 页面、目录列表、读取进度和数据 API |
| `server/server.js` | 复用原有目录扫描建立工具箱索引，避免每次请求同步扫描网络文件系统 |
| `client/toolbox/worker.js` | 缓存算例，后台执行数值计算，防止计算阻塞控件 |
| `client/toolbox/index.js` | 页签、参数、算例搜索、状态、原位重画、设置导入导出和文字编辑保留 |
| `client/toolbox/figures.js` | 单图、对比版式、双轴和梯度核对的 Plotly 描述 |
| `views/toolbox.pug` / `public/stylesheets/toolbox.css` | 页面结构、完整路径换行、响应式布局与主题适配 |

服务器最多缓存两个算例，总缓存上限 192 MiB；同一算例的并发请求共享读取。文件大小、修改时间、设备或 inode 变化后，重新载入会自动失效缓存。超出缓存上限的单个算例仍可返回，但不长期保留。重新读取只针对当前选中算例，刷新目录才复用原目录扫描逻辑重新扫描。

## 部署和离线更新

发布包仅需项目原有的 Node.js 22+。上传、解压，配置 `.env` 后运行 `npm start`。工具箱不再读取 `PYTHON_EXECUTABLE`，不需要运行 pip、创建 Python 虚拟环境或安装 ARM/x86 专用 wheel。

已具备构建依赖的开发机上可以运行：

```bash
npm run pack-client
npm run pack-server
node util/pack.js
```

完整 `npm run pack` 仍沿用项目原有的构建流程。生成的 `GTC-Visualization.tar.gz` 包括工具箱主脚本和 Web Worker，排除 Python、wheelhouse 和离线 Python 安装脚本。

## 数值和功能核对

```bash
node --test test/spatiotemporal.test.js test/pack.test.js
```

合成基准由原 Python 代码独立生成，覆盖四种物理量、两种单位、非均匀网格、径向重采样、磁通插值、末尾不完整帧、平滑边界（窗口等于整条曲线长度）、原始统计不受显示操作影响、非法输入、对比图的双轴单位和二进制传输。HTTP 检查覆盖 gzip、缓存并发、文件变化失效及任意路径拒绝。

开发时需要 Python 参考环境才能重新生成基准或执行真实数据核对；这些工具不在生产流程中使用：

```bash
python util/generate-toolbox-reference.py
node util/check-toolbox-parity.js /path/to/a/GTC-output
```

2026-10-23 使用一个 129 MB、5,077 条记录、121 个径向点的真实算例核对，共逐项比较约 500 万个数值。四种物理量 × 两种单位的矩阵、径向均值、平滑曲线、窗口剖面及统计量通过；最大相对差约 1.2×10⁻¹³，属于浮点运算次序误差。

本机测得首次解析约 2.38 秒，浏览器首次载入约 2.65 秒，单图重画约 0.25 秒，双热图约 0.40 秒。耗时受数据规模、机器、浏览器、网络及服务器文件系统影响；这些记录用于说明本次本地检查结果。
