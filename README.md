# GTC-Visualization

This node app provides a simple way to inspect GTC(Gyrokinetic Toroidal Code) output data. Once deployed on the server, you can examine various plot generated from raw output data, without downloading any files.

## Requirements

- Node.js 22 or newer.
- The [Emscripten SDK (emsdk)](https://github.com/emscripten-core/emsdk)
  is required when rebuilding the FFTE WebAssembly binary. Install and
  activate a current SDK before using `emcmake`:

  ```bash
  git clone https://github.com/emscripten-core/emsdk.git
  cd emsdk
  ./emsdk install latest
  ./emsdk activate latest
  source ./emsdk_env.sh
  ```

  On Windows PowerShell, load the environment with `.\emsdk_env.ps1` instead.
  See [`ffte/README.md`](ffte/README.md#webassembly-build) for the complete WASM
  build commands. The checked-in WASM assets are sufficient if FFTE itself is
  not being changed.

## Quick start
1. Clone the repository and its FFTE submodule:
   `git clone --recurse-submodules https://github.com/12ff54e/GTC-Visualization`.
   For an existing clone, run `git submodule update --init --recursive`.
2. `cp .env_example .env` and modifies it as you wish.
   - **PORT** is the port to which this app listening. Set a larger number to avoid conflicts.
   - **HOST_DIR** is the folder where this app will search gtc output files in.
   - **LIMIT** is the maximum number of concurrent opening GTC output folders.
   - **SHOW_PATH** is a boolean determining whether the front end can see the whole path
3. run
    ```bash
    npm install
    npm test
    ```
   `npm test` builds custom Plotly and source-mapped development client bundles
   before starting the development server.
   The editable browser sources are in `client/`; `npm run pack-client`
   generates the scripts served from `public/javascripts/`.
**Note**: `npm install` needs access to a npm repository. If your server do not have Internet access, you can run `npm run pack` and all necessary files are packed into a compressed file, which you can upload to your server. Or download the latest version from [here](https://github.com/12ff54e/GTC-Visualization/releases/download/latest/GTC-Visualization.tar.gz). Then you can unpack files and start the server by
   ```bash
   tar -xf GTC-Visualization.tar.gz
   cd GTC-Visualization
   mv .env_example .env
   # change .env file as you wish
   npm start
   ```
You can also, and I suggest to, use process manager or init system to keep app ALWAYS running.

## smiao 的工具箱

首页点击“smiao 的工具箱”，选择包含 `gtc.out` 和 `data1d.out` 的算例，即可交互查看 D_i、D_f、Gamma_i、Gamma_f 以及物种对比图。D_f 需要第三物种，Gamma_f 还需要同一目录的 `profile.dat`。

工具箱已经完整改用 Node.js 和浏览器 JavaScript，直接使用项目的 Plotly 绘图。部署时仅需项目原有的 Node.js 环境。数据在选中算例时读取并缓存，调整范围、单位、平滑和物理参数时复用缓存；计算在 Web Worker 中完成，页面可继续操作。

左侧包含分析、物理参数、图形三个页签，支持五种对比版式、径向平均范围、统计窗口、时间显示范围、Raw/Smoothed 样式、共用/独立色标、Gamma 双纵轴和梯度核对。双击图内标题、轴标题或图例可编辑文字；图表右上角使用原项目的图片与 CSV/JSON 下载工具。保存设置后可再次导入。

计算规则及迁移说明见 [TOOLBOX_JS_MIGRATION.md](TOOLBOX_JS_MIGRATION.md)。原 Python 数值代码保留在源码仓库供开发核对，发布包中只包含 JavaScript 运行资产。

## What's behind the scene
This app use [express.js](http://www.expressjs.com) as server framework, and plot figures with the help of [Plotly.js](https://plotly.com/javascript/), which relies on [MathJax](https://www.mathjax.org/) to render expressions. Most, if not all figure types are from [Huasheng Xie](http://hsxie.github.io/)'s Matlab program.
