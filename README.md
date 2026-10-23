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

## smiao 的工具箱（可选）

首页的“smiao 的工具箱”可从扫描到的算例中选择包含 `gtc.out` 和 `data1d.out` 的目录，生成 D_i、D_f、Gamma_i 或 Gamma_f 的时空图及径向平均曲线。Gamma_f 还需要同一目录中的 `profile.dat`。生成结果提供 PNG、PDF、SVG、NPZ 和 JSON 下载。

该功能调用随项目打包的 Python 数值脚本。需要 Python 3.8 或更新版本，以及 NumPy、SciPy 和 Matplotlib：

```bash
python -m pip install -r python-tools/di-spatiotemporal/requirements.txt
```

如果服务器不能联网，可在有网络的构建机上为目标服务器准备 wheelhouse，再生成带依赖的发布包。下面示例针对服务器的 Linux aarch64、CPython 3.8；目标平台参数必须按服务器实际 Python ABI 修改：

```bash
PYTHON_TARGET_PLATFORM=manylinux2014_aarch64 \
PYTHON_TARGET_VERSION=38 \
PYTHON_TARGET_IMPLEMENTATION=cp \
PYTHON_TARGET_ABI=cp38 \
node util/prepare-python-offline.js && node util/pack.js
```

不设置这些参数时，会下载构建机当前平台可用的 wheel。将生成的 `GTC-Visualization.tar.gz` 上传并解压后，在服务器运行：

```bash
sh install-python-tools.sh
npm start
```

安装脚本先从 wheelhouse 离线更新 pip，再安装 NumPy、SciPy 和 Matplotlib，不访问网络。服务器仍需预装与 wheelhouse 匹配的 Python（示例为 Python 3.8）；此包不包含 Python 解释器。`PYTHON_EXECUTABLE` 可用于指定服务器上的解释器路径。

默认在 Windows 使用 `python`，其他系统使用 `python3`。如果 Python 命令不在 PATH 中，可在 `.env` 中设置 `PYTHON_EXECUTABLE` 为解释器的可执行文件路径。运行 Node 服务的账号需要能读取 `HOST_DIR` 中的 GTC 文件，并能写入项目下的 `public/toolbox-results/`。

## What's behind the scene
This app use [express.js](http://www.expressjs.com) as server framework, and plot figures with the help of [Plotly.js](https://plotly.com/javascript/), which relies on [MathJax](https://www.mathjax.org/) to render expressions. Most, if not all figure types are from [Huasheng Xie](http://hsxie.github.io/)'s Matlab program.
