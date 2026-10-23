"""从 gtc.out / data1d.out / profile.dat 绘制 D_i、D_f、Gamma_i、Gamma_f 时空演化。

改写自 data1d_flux_ra.m 的 plot_spatiotemporal_evolution：
  上图显示所选扩散系数或扩散粒子通量，下图为对应量的 r 加权平均；
  可选时间窗口标记，支持物理量/时间轴切换，以及径向平均范围、时间显示范围调整。
双击启动脚本后，左侧调参数、右侧预览；点击“保存当前图…”选择文件夹后保存。
命令行加 --no-show 可无窗口批量导出。
Gamma_i = -D_i[SI] * d n_i[SI]/dr[m]；先逐点换算，再做径向平均。
Gamma_f = -D_f[SI] * d n_f[SI]/dr[m]；n_f 来自 profile.dat，先按极向磁通对齐。
"""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass, replace
import hashlib
import json
from pathlib import Path
import re
import warnings

import matplotlib
from matplotlib.colors import LinearSegmentedColormap, Normalize
from matplotlib.ticker import AutoMinorLocator, MaxNLocator, ScalarFormatter
import numpy as np
from scipy.interpolate import interp1d
from scipy.signal import savgol_filter


# ==================== 1. 常用参数（可直接修改） ====================
BASE = Path(__file__).resolve().parent
DEFAULT_OUTPUT = BASE / "output"
# 以下是找不到运行参数时的备用值，沿用原 MATLAB。
# 实际运行优先使用命令行/GUI 手动值，其次自动读取 gtc.out，最后才用备用值。
DEFAULT_R0 = 1.89             # 大半径，m
DEFAULT_A = 0.433             # 小半径，m
DEFAULT_B0 = 2.44             # 磁场，T；仅 SI 单位换算需要
DEFAULT_TREF_EV = 1090.0      # 参考温度，eV；仅 SI 单位换算需要
DEFAULT_TSTEP = 0.04          # 每条 data1d 诊断记录对应的时间，单位 R0/Cs
DEFAULT_START = 1600          # 1 起算，包含该记录；不是原始模拟步数
DEFAULT_END = 2000            # 1 起算，包含该记录
DEFAULT_UNITS = "normalized" # normalized: T_ref/(e B0)；si: m^2/s
DEFAULT_TIME_AXIS = "physical"
DEFAULT_QUANTITY = "di"      # di/df: 扩散系数；gamma/gammaf: 对应扩散粒子通量
GAMMA_DISPLAY_SCALE = 1e19    # 通量图以 10^19 m^-2 s^-1 为单位

FIGSIZE = (8.4, 7.8)
EXPORT_DPI = 600
PREVIEW_DPI = 150
FORMATS = ("png", "pdf", "svg")  # 不生成 TIFF
FONT_SIZE = 14
LABEL_SIZE = 18
LINE_WIDTH = 1.6
# 默认柔和蓝—白—红，零值对应白色；正负号保留。
# 可用 --cmap jet 恢复 MATLAB 示例的 jet 配色。
DEFAULT_CMAP = "soft_bwr"
# None 表示全数据最大绝对值的对称范围，不自动截去极值。
# 例如改成 (-3e-4, 3e-4) 可沿用旧 D_i 图的色标；数字使用当前所选单位。
COLOR_LIMITS = None
GAMMA_COLOR_LIMITS = None    # Gamma 独立色标，数值单位为 10^19 m^-2 s^-1
DF_COLOR_LIMITS = None       # D_f 独立色标；None 用完整 D_f 数据自动定标
GAMMAF_COLOR_LIMITS = None   # Gamma_f 独立色标；单位 10^19 m^-2 s^-1


@dataclass
class Settings:
    r0: float = DEFAULT_R0
    a: float = DEFAULT_A
    b0: float = DEFAULT_B0
    tref_ev: float = DEFAULT_TREF_EV
    tstep: float = DEFAULT_TSTEP
    start: int = DEFAULT_START
    end: int = DEFAULT_END
    units: str = DEFAULT_UNITS
    time_axis: str = DEFAULT_TIME_AXIS
    cmap: str = DEFAULT_CMAP
    quantity: str = DEFAULT_QUANTITY
    nref_19: float | None = None  # 密度归一化参考值，单位 10^19 m^-3；优先读 gtc.out
    mean_rmin: float | None = None  # 径向平均下限 r/a；两端留空表示整个有效网格
    mean_rmax: float | None = None  # 径向平均上限 r/a；包括端点处的网格中心
    smooth_window: int = 1         # 下方曲线的显示平滑：1=关闭；推荐 31 或 51（奇数）
    show_time_window: bool = True  # 仅控制时间窗口阴影、竖虚线和文字；不改变任何统计
    time_min: float | None = None  # 两图的显示起点，单位始终为 R0/Cs；留空=首条记录
    time_max: float | None = None  # 两图的显示终点，留空=末条记录；与 start/end 统计窗口独立

    def validate(self):
        for name in ("r0", "a", "b0", "tref_ev", "tstep"):
            value = getattr(self, name)
            if not np.isfinite(value) or value <= 0:
                raise ValueError(f"{name} 必须是正的有限数值。")
        if self.start < 1 or self.end < self.start:
            raise ValueError("平均窗口必须满足 1 <= start <= end，端点均包含。")
        if self.units not in ("normalized", "si") or self.time_axis not in ("physical", "step"):
            raise ValueError("单位设置无效。")
        if self.quantity not in ("di", "gamma", "df", "gammaf"):
            raise ValueError("quantity 应为 di、gamma、df 或 gammaf。")
        if self.nref_19 is not None and (not np.isfinite(self.nref_19) or self.nref_19 <= 0):
            raise ValueError("nref_19 必须为正数，或留空自动识别。")
        for name in ("mean_rmin", "mean_rmax", "time_min", "time_max"):
            value = getattr(self, name)
            if value is not None and (not np.isfinite(value) or value < 0):
                raise ValueError(f"{name} 必须是非负有限数值，或留空。")
        if self.mean_rmin is not None and self.mean_rmax is not None and self.mean_rmin >= self.mean_rmax:
            raise ValueError("径向平均下限必须小于上限。")
        if self.time_min is not None and self.time_max is not None and self.time_min >= self.time_max:
            raise ValueError("时间显示起点必须小于终点，单位为 R0/Cs。")
        if not isinstance(self.smooth_window, (int, np.integer)) or self.smooth_window < 1 or self.smooth_window % 2 != 1:
            raise ValueError("平滑窗口必须为正奇数；1 表示不平滑。")


# ==================== 2. 读取原始输出（不是读取 FIG） ====================
def read_data1d_di(path, *, include_df=False):
    """物种 1 首通道为 D_i；物种 3 首通道为 D_f（若存在）。

    include_df=False 保留旧的 (D_i, 元数据) 接口；True 返回 (D_i, D_f, 元数据)。
    """
    path = Path(path)
    text = path.read_text(encoding="utf-8-sig").replace("D", "E").replace("d", "e")
    if re.search(r"[^0-9eE.+\-\s]", text):
        raise ValueError("data1d.out 应为纯数值文本；发现非数字内容或 Fortran 溢出符号。")
    with warnings.catch_warnings():
        warnings.simplefilter("error", DeprecationWarning)
        try:
            raw = np.fromstring(text, sep=" ", dtype=np.float64)
        except (ValueError, DeprecationWarning) as exc:
            raise ValueError("无法完整解析 data1d.out 数值流。") from exc
    if len(raw) < 7 or not np.all(np.isfinite(raw)):
        raise ValueError("data1d.out 文件头不足 7 个数，或包含非有限数值。")
    header = raw[:7]
    if not np.all(header == np.floor(header)):
        raise ValueError("data1d.out 前 7 个头参数应为整数。")
    # 保留 raw(1) 作为元数据，不用它再次乘时间轴。
    # MATLAB: mpsi = raw(2)-1，因此径向点数直接等于 raw(2)。
    nr, nspecies, mpdata, nfield, mfdata = map(int, header[[1, 2, 4, 5, 6]])
    if nr < 2 or nspecies < 1 or mpdata < 1 or nfield < 0 or mfdata < 0:
        raise ValueError("data1d.out 文件头给出的网格/通道数量无效。")
    nchannels = nspecies * mpdata + nfield * mfdata
    frame_size = nr * nchannels
    ntime, remainder = divmod(len(raw) - 7, frame_size)
    if ntime < 2:
        raise ValueError("至少需要两条完整诊断记录才能画时空演化图。")
    if remainder:
        warnings.warn(f"文件末尾有 {remainder} 个数不足一帧，沿用 MATLAB floor 规则忽略；已记录到校验文件。")
    # 按时间 -> 通道 -> 半径重排，径向索引变化最快。
    frames = raw[7:7 + ntime * frame_size].reshape(ntime, nchannels, nr)
    di = frames[:, 0, :].copy()
    # data1d_flux_ra.m/read_data1d_coeffs：第三物种的第一个通道。
    # 缺少第三物种时返回 None，绝不以别的通道或全零矩阵冒充 D_f。
    df = frames[:, 2 * mpdata, :].copy() if nspecies >= 3 else None
    metadata = {"header": header.astype(int).tolist(), "radial_points": nr,
                "nspecies": nspecies, "mpdata1d": mpdata, "nfield": nfield,
                "mfdata1d": mfdata, "frame_size": frame_size, "records": ntime,
                "ignored_trailing_values": remainder, "species_1based": 1,
                "channel_1based": 1}
    return (di, df, metadata) if include_df else (di, metadata)


def read_gtc_profiles(path, *, include_psi=False):
    """读 r/R0 和归一化离子密度；优先按 meshni 列名定位，避免混入电子/快离子。"""
    lines = Path(path).read_text(encoding="utf-8-sig", errors="replace").splitlines()
    markers = [i for i, line in enumerate(lines) if "Key profiles on radial mesh:" in line]
    if len(markers) != 1:
        raise ValueError(f"gtc.out 应包含一个 Key profiles 数据块，实际找到 {len(markers)} 个。")
    rows, column_names = [], []
    for line in lines[markers[0] + 1:]:
        line = line.strip()
        if not line:
            continue
        try:
            values = [float(token.replace("D", "E").replace("d", "e")) for token in line.split()]
        except ValueError:
            if rows:
                break  # 只读连续剖面表，不把后面的其他数值表拼进来。
            tokens = line.lower().replace(",", " ").split()
            if tokens and tokens[0] in ("i", "index", "ir"):
                column_names = tokens
            continue
        if len(values) < 8:
            if rows:
                break
            continue
        rows.append(values)
    if len(rows) < 2:
        raise ValueError("未读到有效径向剖面表（至少两行，每行至少 8 列）。")
    indices = np.array([row[0] for row in rows])
    radius = np.array([row[1] for row in rows])
    if not np.all(np.isfinite(indices)) or not np.all(indices == np.floor(indices)) or not np.all(np.diff(indices) == 1):
        raise ValueError("剖面表索引不连续，请检查 Key profiles 数据块。")
    if not np.all(np.isfinite(radius)) or radius.min() < 0 or not np.all(np.diff(radius) > 0):
        raise ValueError("剖面表第 2 列应是非负、严格递增的 r/R0。")
    if len({len(row) for row in rows}) != 1:
        raise ValueError("Key profiles 表的数值列数不一致。")
    candidates = [i for i, name in enumerate(column_names) if name in ("meshni", "ni", "n_i")]
    if len(candidates) == 1:
        ni_column = candidates[0]
        method = "header_name"
    elif not column_names and len(rows[0]) in (8, 10):
        # 兼容原 MATLAB 的无列名表：8 列时 ni 在第 8 列，10 列时在第 9 列。
        ni_column = 7 if len(rows[0]) == 8 else 8
        method = "MATLAB_8_or_10_column_layout"
        warnings.warn("缺少剖面列名，按原 MATLAB 的 8/10 列格式定位 ni，请核对。")
    else:
        raise ValueError("无法唯一识别离子密度列 meshni/ni/n_i，请检查剖面表头。")
    if ni_column >= len(rows[0]):
        raise ValueError("离子密度列索引超出剖面表数值列数。")
    ni_norm = np.array([row[ni_column] for row in rows])
    if not np.all(np.isfinite(ni_norm)) or np.any(ni_norm < 0) or not np.any(ni_norm > 0):
        raise ValueError("离子密度应为非负有限数值，且不能全为零。")
    metadata = {"ion_density_column_1based": ni_column + 1,
                "column_names": column_names, "selection_method": method}
    if include_psi:
        # profile.dat 的第一列是极向磁通；必须按这个坐标对齐快离子密度。
        psi = np.array([row[2] for row in rows])
        if not np.all(np.isfinite(psi)) or not np.all(np.diff(psi) > 0):
            raise ValueError("gtc.out 剖面表第 3 列的极向磁通必须严格递增。")
        return radius, ni_norm, metadata, psi
    return radius, ni_norm, metadata


def read_gtc_radius(path):
    """保留旧函数接口；完整绘图使用 read_gtc_profiles 同时取得密度。"""
    return read_gtc_profiles(path)[0]


def read_gtc_parameters(path):
    """读取 GTC 回显的运行参数，避免把另一个算例的 a、时间步等硬套进来。"""
    text = Path(path).read_text(encoding="utf-8-sig", errors="replace")
    number = r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?"
    def last(pattern):
        matches = re.findall(pattern, text, flags=re.MULTILINE | re.IGNORECASE)
        return float(matches[-1].replace("D", "E").replace("d", "e")) if matches else None
    # GTC 的 PHYSICAL_PARAMETERS 输出采用 cm、Gauss、eV。
    # 取最后一次赋值，因为读取平衡后会更新初始输入的 ETEMP0 等参数。
    r0_cm = last(r"^\s*R0\s*=\s*(" + number + r")")
    b0_gauss = last(r"^\s*B0\s*=\s*(" + number + r")")
    tref = last(r"^\s*ETEMP0\s*=\s*(" + number + r")")
    eden0_cm3 = last(r"^\s*EDEN0\s*=\s*(" + number + r")")
    density_on_axis = bool(re.search(r"density profiles normalized to on-axis electron value", text, re.IGNORECASE))
    dt = last(r"^\s*TSTEP\s*=\s*(" + number + r")")
    ndiag = last(r"^\s*NDIAG\s*=\s*(" + number + r")")
    psiw = last(r"^\s*more eqdata:\s*ped,psiw,rmaj=\s*" + number + r"\s+(" + number + r")")
    fload = last(r"^\s*FLOAD\s*=\s*(" + number + r")")
    feload = last(r"^\s*FELOAD\s*=\s*(" + number + r")")
    a_r0 = last(r"at last closed flux surface\s+a_minor\s*=\s*(" + number + r")")
    inferred = {}
    if r0_cm is not None:
        inferred["r0"] = r0_cm / 100.0
    if b0_gauss is not None:
        inferred["b0"] = b0_gauss / 10000.0
    if tref is not None:
        inferred["tref_ev"] = tref
    if eden0_cm3 is not None and density_on_axis:
        # cm^-3 -> m^-3 乘 10^6，再除 10^19，因此系数为 10^-13。
        inferred["nref_19"] = eden0_cm3 * 1e-13
    if a_r0 is not None and r0_cm is not None:
        inferred["a"] = a_r0 * inferred["r0"]
    if dt is not None and ndiag is not None:
        inferred["tstep"] = dt * ndiag
    rg = re.search(r"rg0,rg1\s*=\s*(" + number + r")\s+(" + number + r")", text, re.IGNORECASE)
    return {"inferred": inferred, "a_over_r0": a_r0,
            "reported_r_over_a": [float(v.replace("D", "E")) for v in rg.groups()] if rg else None,
            "solver_tstep": dt, "ndiag": ndiag, "profile_psiw": psiw,
            "fast_ion_load": fload, "fast_electron_load": feload,
            "eden0_cm3": eden0_cm3, "density_normalized_to_axis_electron": density_on_axis}


def read_fast_density_profile(path, psi_gtc, radius_m, psiw, *, fast_electron_load=None):
    """把 profile.dat 的 nf(cm^-3) 对齐到 gtc.out 网格，并求 dn_f/dr(m)。

    GTC eqdata.F90 先令 profile.dat 的末点极向磁通等于 psiw，再按极向磁通
    插值。profile.dat 的 r 列在此算例全为零，绝不能用它计算梯度。
    """
    if fast_electron_load not in (None, 0):
        raise ValueError("FELOAD>0 时 profile.dat 第 14 列可能是快电子密度，不能当作 n_f。")
    if psiw is None or not np.isfinite(psiw) or psiw <= 0:
        raise ValueError("gtc.out 缺少有效 psiw，无法把 profile.dat 的极向磁通对齐到径向网格。")
    if np.shape(psi_gtc) != np.shape(radius_m) or len(psi_gtc) < 2:
        raise ValueError("gtc.out 极向磁通与物理半径的网格不匹配。")
    lines = Path(path).read_text(encoding="utf-8-sig").splitlines()
    if len(lines) < 3:
        raise ValueError("profile.dat 至少需要表头和两个径向数据点。")
    header = lines[0].lower().split()
    if header.count("pol-flux") != 1 or header.count("nf") != 1:
        raise ValueError("profile.dat 表头必须包含唯一的 pol-flux 和 nf 列。")
    numeric = "\n".join(lines[1:]).replace("D", "E").replace("d", "e")
    if re.search(r"[^0-9eE.+\-\s]", numeric):
        raise ValueError("profile.dat 的数值区包含无法解析的字符。")
    raw = np.fromstring(numeric, sep=" ", dtype=float)
    if len(raw) < 2*len(header) or len(raw) % len(header) or not np.all(np.isfinite(raw)):
        raise ValueError("profile.dat 数值行不完整，或包含非有限数值。")
    table = raw.reshape(-1, len(header))
    psi_source = table[:, header.index("pol-flux")]
    nf_cm3 = table[:, header.index("nf")]
    if psi_source[0] < 0 or not np.all(np.diff(psi_source) > 0):
        raise ValueError("profile.dat 极向磁通必须从非负值严格递增。")
    if np.any(nf_cm3 < 0) or not np.any(nf_cm3 > 0):
        raise ValueError("profile.dat 的 nf 应为非负值且不能全为零。")
    psi_aligned = psi_source * (psiw / psi_source[-1])
    if psi_gtc[0] < psi_aligned[0] or psi_gtc[-1] > psi_aligned[-1]:
        raise ValueError("gtc.out 径向网格超出 profile.dat 的极向磁通范围；不会外推 n_f。")
    # eqdata.F90 明确说明 profile.dat 的密度以 cm^-3 储存。
    nf_si = np.interp(psi_gtc, psi_aligned, nf_cm3) * 1e6
    grad_nf_si = matlab_radial_gradient(nf_si, radius_m)
    metadata = {"source_column": "nf", "source_unit": "cm^-3", "source_rows": len(table),
                "poloidal_flux_scale_to_gtc": float(psiw/psi_source[-1]),
                "mapping": "linear interpolation in rescaled poloidal flux; no extrapolation",
                "gradient": "MATLAB gradient(f,r): centered secant interior, one-sided edges",
                "profile_r_column_used": False}
    return nf_si, grad_nf_si, metadata


def resolve_settings(args, run_parameters):
    values, origins = {}, {}
    for name in Settings.__dataclass_fields__:
        supplied = getattr(args, name)
        if supplied is not None:
            values[name] = supplied
            origins[name] = "argument_or_dialog"
        elif name in run_parameters["inferred"]:
            values[name] = run_parameters["inferred"][name]
            origins[name] = "gtc.out"
        elif name in ("nref_19", "mean_rmin", "mean_rmax"):
            values[name] = None
            origins[name] = "unavailable" if name == "nref_19" else "full_radial_mesh"
        elif name in ("time_min", "time_max"):
            values[name] = None
            origins[name] = "full_time_range"
        else:
            values[name] = getattr(Settings(), name)
            origins[name] = "MATLAB_fallback"
            warnings.warn(f"gtc.out 未提供 {name}，使用原 MATLAB 备用值 {values[name]}，请核对。")
    return Settings(**values), origins


def matlab_radial_gradient(values, radius_m):
    """复现 MATLAB gradient(f,r)：内部用跨两点差商，边界用单边差商。

    非均匀网格下此公式与 np.gradient(f,r) 的默认内部公式不同，不能直接替换。
    """
    values, radius_m = np.asarray(values), np.asarray(radius_m)
    if values.shape != radius_m.shape or len(values) < 2 or not np.all(np.diff(radius_m) > 0):
        raise ValueError("密度梯度计算需要对应的、严格递增的物理半径。")
    result = np.empty_like(values, dtype=float)
    result[0] = (values[1]-values[0])/(radius_m[1]-radius_m[0])
    result[-1] = (values[-1]-values[-2])/(radius_m[-1]-radius_m[-2])
    result[1:-1] = (values[2:]-values[:-2])/(radius_m[2:]-radius_m[:-2])
    return result


def select_quantity(data, quantity):
    """同步选择热图与平均曲线；共享源数组，不修改四种物理量。"""
    if quantity not in ("di", "gamma", "df", "gammaf"):
        raise ValueError("quantity 应为 di、gamma、df 或 gammaf。")
    if f"{quantity}_values" not in data:
        if quantity == "df":
            raise ValueError("当前 data1d.out 没有第三个物种，无法读取 D_f；请选择包含快离子的 data1d.out。")
        if quantity == "gammaf":
            raise ValueError("Gamma_f 需要第三物种的 D_f 和同算例 profile.dat 的 nf；请检查两个文件。")
        raise ValueError("Gamma_i 换算缺少离子密度或参考密度；请检查 gtc.out 或设置 --nref-19。")
    selected = dict(data)
    selected["quantity"] = quantity
    selected["values"] = data[f"{quantity}_values"]
    selected["mean_time"] = data[f"{quantity}_mean_time"]
    window = slice(data["window_start"]-1, data["window_end"])
    # 数值仍留在数据记录中便于分析，但图中不再画 Window mean 水平线/图例。
    selected["window_mean"] = float(selected["mean_time"][window].mean())
    selected["window_profile_mean"] = selected["values"][window].mean(axis=0)
    return selected


def apply_radial_average(data, settings):
    """只更新径向平均，时空矩阵和局部梯度保持原值；图窗修改区间时无需重读文件。

    采用原 MATLAB 的 r 权重，范围外权重置零，范围内重新归一化。
    端点按现有网格中心筛选，不虚构边界点、不插值、不对梯度先求平均。
    """
    settings.validate()
    radius = data["radius_a"]
    lo = float(radius[0]) if settings.mean_rmin is None else settings.mean_rmin
    hi = float(radius[-1]) if settings.mean_rmax is None else settings.mean_rmax
    if lo < radius[0]-1e-10 or hi > radius[-1]+1e-10:
        raise ValueError(f"平均区间超出实际数据范围 {radius[0]:.6f}–{radius[-1]:.6f}；留空可使用全部数据。")
    mask = (radius >= lo-1e-10) & (radius <= hi+1e-10)
    if lo >= hi or not mask.any():
        raise ValueError("径向平均区间无有效网格点，请放宽区间。")
    weights = np.where(mask, data["radius_m"], 0.0)
    if weights.sum() <= 0:
        raise ValueError("所选径向网格的 r 权重总和必须大于零。")
    weights /= weights.sum()
    result = dict(data)
    result.update({"weights": weights, "radial_mean_mask": mask,
                   "mean_range_requested": [float(lo), float(hi)],
                   "mean_range_actual": radius[mask][[0, -1]].tolist(),
                   "mean_radial_point_count": int(mask.sum()),
                   "di_mean_time": data["di_values"] @ weights})
    if "df_values" in data:
        result["df_mean_time"] = data["df_values"] @ weights
    if "gamma_values" in data:
        result["gamma_mean_time"] = data["gamma_values"] @ weights
    if "gammaf_values" in data:
        result["gammaf_mean_time"] = data["gammaf_values"] @ weights
    return select_quantity(result, settings.quantity)


def smooth_mean_trace(values, window):
    """均匀使用二阶 Savitzky–Golay，只生成显示副本，不更改原始平均或统计。

    window 是诊断点数。不会专门压平末段、去趋势或让数据收敛到指定常数。
    例如 tstep=0.04，51 点首尾相隔 (51-1)*0.04=2.0 R0/Cs。
    """
    if not isinstance(window, (int, np.integer)) or window < 1 or window % 2 != 1:
        raise ValueError("平滑窗口必须是正奇数。")
    if window > len(values):
        raise ValueError(f"平滑窗口 {window} 超过实际诊断点数 {len(values)}。")
    if window == 1:
        return np.array(values, copy=True)
    return savgol_filter(values, window_length=window, polyorder=min(2, window-1), mode="interp")


def variant_suffix(settings):
    """参数写进文件名，新的区间/平滑结果不覆盖旧版。"""
    suffix = ""
    if settings.mean_rmin is not None or settings.mean_rmax is not None:
        name = lambda value: "edge" if value is None else f"{value:g}".replace(".", "p")
        suffix += f"_ra{name(settings.mean_rmin)}-{name(settings.mean_rmax)}"
    if settings.smooth_window > 1:
        suffix += f"_sg{settings.smooth_window}"
    if not settings.show_time_window:
        suffix += "_no_time_window"
    if settings.time_min is not None or settings.time_max is not None:
        name = lambda value: "edge" if value is None else str(float(value)).replace(".", "p")
        suffix += f"_t{name(settings.time_min)}-{name(settings.time_max)}"
    return suffix


def result_directory(output, settings):
    """区间/平滑版本另归一类，旧版 output/PNG 等文件保持不动。"""
    return Path(output)/"区间平均与平滑" if variant_suffix(settings) else Path(output)


def parse_display_options(settings, lower_text, upper_text, window_text,
                          time_min_text="", time_max_text=""):
    """空边界恢复相应数据边界；时间始终按 R0/Cs 输入，不随横轴切换而改义。"""
    lower = float(lower_text) if lower_text.strip() else None
    upper = float(upper_text) if upper_text.strip() else None
    time_min = float(time_min_text) if time_min_text.strip() else None
    time_max = float(time_max_text) if time_max_text.strip() else None
    result = replace(settings, mean_rmin=lower, mean_rmax=upper, smooth_window=int(window_text),
                     time_min=time_min, time_max=time_max)
    result.validate()
    return result


def time_display_limits(data, settings, time_axis=None):
    """检查显示时段，再转换到当前横轴；不裁剪矩阵，也不改变平均和平滑计算。

    允许显示起点设为 0（首条记录通常在 tstep），但不补造 t=0 数据。
    仅容忍时间步长文本舍入产生的微小边界误差，例如末帧 122.99999754 输入 123。
    """
    settings.validate()
    time = np.asarray(data["physical_time"])
    first, last = float(time[0]), float(time[-1])
    lo = first if settings.time_min is None else settings.time_min
    hi = last if settings.time_max is None else settings.time_max
    tolerance = max(settings.tstep * 1e-3, abs(last) * 1e-10)
    if lo > last + tolerance or hi > last + tolerance:
        raise ValueError(f"时间显示范围超过数据终点 {last:.9g} R0/Cs；终点留空可显示至最后记录。")
    lo, hi = min(lo, last), min(hi, last)
    if lo >= hi or not np.any((time >= lo - tolerance) & (time <= hi + tolerance)):
        raise ValueError(f"所选时段不包含诊断记录；实际时间为 {first:.9g}–{last:.9g} R0/Cs。")
    # 固定保存物理时间，避免切换横轴后把同一数字误解释为不同的时段。
    divisor = settings.tstep if (time_axis or settings.time_axis) == "step" else 1.0
    return lo / divisor, hi / divisor


def prepare_data(di_raw, radius_r0, settings, ni_norm=None, df_raw=None, nf_si=None, grad_nf_si=None):
    settings.validate()
    ntime, nr = di_raw.shape
    if settings.start > ntime:
        raise ValueError(f"平均起点 {settings.start} 超过实际 {ntime} 条记录，请调整 --start / --end。")
    end = min(settings.end, ntime)
    if end != settings.end:
        warnings.warn(f"平均终点从 {settings.end} 收至最后一条完整记录 {end}。")
    if df_raw is not None and (np.shape(df_raw) != di_raw.shape or not np.all(np.isfinite(df_raw))):
        raise ValueError("D_f 的时间/径向维度或数值与 D_i 不匹配。")
    if (nf_si is None) != (grad_nf_si is None):
        raise ValueError("计算 Gamma_f 时必须同时提供 n_f 和 dn_f/dr。")
    resampled = nr != len(radius_r0)
    if resampled:
        # 严格复现 MATLAB 的网格不一致处理：在归一化网格索引上逐帧线性插值。
        # 这假定两个网格描述同一径向区间；不声称已知 data1d 的独立物理网格。
        old = np.linspace(0, 1, nr)
        new = np.linspace(0, 1, len(radius_r0))
        di = interp1d(old, di_raw, axis=1, kind="linear", bounds_error=True)(new)
        df = interp1d(old, df_raw, axis=1, kind="linear", bounds_error=True)(new) if df_raw is not None else None
        warnings.warn(f"径向点数 {nr} -> {len(radius_r0)}，按原 MATLAB 的归一化索引线性插值。")
    else:
        di = di_raw.copy()
        df = df_raw.copy() if df_raw is not None else None
    radius_m = radius_r0 * settings.r0
    radius_a = radius_m / settings.a
    # 若参考温度以 eV 输入，T_ref/(e B0) 转成 m^2/s 的数值因子是 T_ref[eV]/B0[T]。
    # D_i 无需乘 |grad n|、n|grad T| 或 1/1000；这些只属于原来的通量图。
    factor = settings.tref_ev / settings.b0 if settings.units == "si" else 1.0
    values = di * factor
    # 精确沿用 MATLAB 的 sum(D*r)/sum(r)。这是 r 加权环形近似，
    # 不是使用真实磁面 Jacobian 的体积分；也不额外乘径向网格间隔。
    weights = radius_m / radius_m.sum()
    mean_time = values @ weights
    steps = np.arange(1, ntime + 1, dtype=float)
    physical_time = steps * settings.tstep  # tstep 已含诊断间隔，不能再乘头参数。
    selected = slice(settings.start - 1, end)  # MATLAB 1 起算、含终点 -> Python 切片。
    data = {"di_source": di_raw, "di_on_profile_grid": di, "values": values,
            "di_values": values, "di_mean_time": mean_time,
            "radius_r0": radius_r0, "radius_m": radius_m, "radius_a": radius_a,
            "record_index": steps, "physical_time": physical_time, "weights": weights,
            "mean_time": mean_time, "window_mean": float(mean_time[selected].mean()),
            "window_profile_mean": values[selected].mean(axis=0),
            "window_start": settings.start, "window_end": end,
            "radial_resampled": resampled, "conversion_factor": factor}
    if df is not None:
        df_values = df * factor  # 与 D_i 相同的 T_ref[eV]/B0[T] 系数；无需密度梯度。
        data.update({"df_source": df_raw, "df_on_profile_grid": df,
                     "df_values": df_values, "df_mean_time": df_values @ weights})
        if nf_si is not None:
            nf_si = np.asarray(nf_si, dtype=float)
            grad_nf_si = np.asarray(grad_nf_si, dtype=float)
            if (nf_si.shape != radius_m.shape or grad_nf_si.shape != radius_m.shape
                    or not np.all(np.isfinite(nf_si)) or not np.all(np.isfinite(grad_nf_si))
                    or np.any(nf_si < 0)):
                raise ValueError("快离子密度及梯度必须与 gtc.out 径向网格匹配，且均为有限数值。")
            # 局部换算后才做径向平均，不能用平均 D_f 乘一个平均梯度。
            df_si = df * (settings.tref_ev/settings.b0)
            gammaf_si = -df_si * grad_nf_si[None, :]
            gammaf_values = gammaf_si/GAMMA_DISPLAY_SCALE
            data.update({"nf_si": nf_si, "grad_nf_si": grad_nf_si, "df_si": df_si,
                         "gammaf_si": gammaf_si, "gammaf_values": gammaf_values,
                         "gammaf_mean_time": gammaf_values @ weights})
    if ni_norm is not None and settings.nref_19 is not None:
        ni_norm = np.asarray(ni_norm, dtype=float)
        if ni_norm.shape != radius_m.shape or not np.all(np.isfinite(ni_norm)) or np.any(ni_norm < 0):
            raise ValueError("离子密度与剖面径向网格不匹配或数值无效。")
        ni_si = ni_norm * settings.nref_19 * 1e19
        grad_ni_si = matlab_radial_gradient(ni_si, radius_m)  # dn_i/dr，单位 m^-4
        # 通量始终由 SI 的 D_i 计算，不能因为显示 normalized/si 而重复或漏乘因子。
        di_si = di * (settings.tref_ev/settings.b0)
        gamma_si = -di_si * grad_ni_si[None, :]  # m^-2 s^-1，保留方向符号
        gamma_values = gamma_si/GAMMA_DISPLAY_SCALE
        # 梯度随半径变化，必须先计算 Gamma(r,t)，再按同一 r 权重求平均。
        # 但如果主要输运区域的梯度近似常数，两条平均曲线仍会近似成比例；
        # 分别自动缩放纵轴时尤其相似。不能为了改变形状而重复乘梯度。
        gamma_mean_time = gamma_values @ weights
        data.update({"ni_norm": ni_norm, "ni_si": ni_si, "grad_ni_si": grad_ni_si,
                     "di_si": di_si, "gamma_si": gamma_si,
                     "gamma_values": gamma_values, "gamma_mean_time": gamma_mean_time})
    return apply_radial_average(data, settings)


# ==================== 3. 绘图与交互 ====================
def unit_labels(settings):
    if settings.quantity in ("gamma", "gammaf"):
        suffix = "i" if settings.quantity == "gamma" else "f"
        return (rf"$\Gamma_{suffix}\;(10^{{19}}\,\mathrm{{m^{{-2}}s^{{-1}}}})$",
                rf"$\langle\Gamma_{suffix}\rangle_r\;(10^{{19}}\,\mathrm{{m^{{-2}}s^{{-1}}}})$")
    unit = r"\mathrm{m^2\,s^{-1}}" if settings.units == "si" else r"T_{\mathrm{ref}}/(eB_0)"
    symbol = "f" if settings.quantity == "df" else "i"
    return rf"$D_{symbol}\;({unit})$", rf"$\langle D_{symbol}\rangle_r\;({unit})$"


def make_figure(data, settings, *, time_axis=None, quantity=None, figure=None,
                show_raw_mean=True, show_smoothed_mean=True,
                raw_mean_color="#b2b7bf", smoothed_mean_color="#3f689c",
                raw_mean_linestyle="-", smoothed_mean_linestyle="-",
                raw_mean_marker=None, smoothed_mean_marker=None,
                raw_mean_markevery=1, smoothed_mean_markevery=1):
    import matplotlib.pyplot as plt

    settings = replace(settings, quantity=quantity or settings.quantity)
    data = apply_radial_average(data, settings)
    symbol = {"gamma": r"\Gamma_i", "gammaf": r"\Gamma_f",
              "di": "D_i", "df": "D_f"}[settings.quantity]
    mode = time_axis or settings.time_axis
    time = data["physical_time"] if mode == "physical" else data["record_index"]
    display_limits = time_display_limits(data, settings, mode)
    xlabel = r"$t\;(R_0/C_s)$" if mode == "physical" else "Diagnostic record"
    scale = settings.tstep if mode == "physical" else 1.0
    start, end = data["window_start"] * scale, data["window_end"] * scale
    plt.rcParams.update({"font.family": "sans-serif", "font.sans-serif": ["Arial", "DejaVu Sans"],
                         "font.size": FONT_SIZE, "mathtext.fontset": "stix", "axes.labelsize": LABEL_SIZE,
                         "axes.linewidth": 1.4, "figure.facecolor": "white", "axes.facecolor": "white",
                         "pdf.fonttype": 42, "svg.fonttype": "none", "path.simplify": False})
    fig = figure if figure is not None else plt.figure(figsize=FIGSIZE)
    if figure is not None:
        fig.clear()
    grid = fig.add_gridspec(2, 2, left=0.16, right=0.88, bottom=0.115, top=0.91,
                           height_ratios=[1.08, 1], width_ratios=[1, 0.038], hspace=0.42, wspace=0.075)
    ax_map = fig.add_subplot(grid[0, 0])
    cax = fig.add_subplot(grid[0, 1])
    ax_mean = fig.add_subplot(grid[1, 0], sharex=ax_map)
    if settings.cmap == "soft_bwr":
        cmap = LinearSegmentedColormap.from_list("soft_bwr", ["#7777ed", "#ffffff", "#ef7777"], N=257)
    else:
        cmap = plt.get_cmap(settings.cmap)
    bound = float(np.max(np.abs(data["values"]))) or 1.0
    configured_limits = {"gamma": GAMMA_COLOR_LIMITS, "gammaf": GAMMAF_COLOR_LIMITS,
                         "di": COLOR_LIMITS, "df": DF_COLOR_LIMITS}[settings.quantity]
    limits = configured_limits if configured_limits is not None else (-bound, bound)
    if not (np.isfinite(limits).all() and limits[0] < limits[1]):
        raise ValueError("色标上下限必须为有限递增数值。")
    # data1d 矩阵是 [时间, 半径]，pcolormesh 需要 [半径, 时间]，因此仅在此转置。
    # 与 imagesc 不同，真实非均匀 r/a 坐标可正确定位；不把它强行拉成等距半径。
    mesh = ax_map.pcolormesh(time, data["radius_a"], data["values"].T,
                            shading="nearest", cmap=cmap, norm=Normalize(*limits), rasterized=True)
    np.testing.assert_array_equal(np.asarray(mesh.get_array()).reshape(data["values"].T.shape), data["values"].T)
    label, mean_label = unit_labels(settings)
    cbar = fig.colorbar(mesh, cax=cax)
    cbar.set_label(label, labelpad=10)
    formatter = ScalarFormatter(useMathText=True)
    formatter.set_powerlimits((-3, 3))
    cbar.formatter = formatter
    cbar.update_ticks()
    ax_map.set_title(rf"${symbol}(r,t)$", fontsize=20, pad=12)
    ax_map.set_ylabel(r"$r/a$", loc="center", labelpad=9)
    ax_map.set_ylim(float(data["radius_a"][0]), float(data["radius_a"][-1]))
    display_mean = smooth_mean_trace(data["mean_time"], settings.smooth_window)
    if not show_raw_mean and not show_smoothed_mean:
        raise ValueError("Raw 和 Smoothed 至少要显示一条曲线。")
    visible_mean_values = []
    legend_items = []
    if settings.smooth_window > 1:
        # 原始波动与平滑趋势可分别隐藏；热图始终保留未经平滑的真实数据。
        if show_raw_mean:
            line, = ax_mean.plot(time, data["mean_time"], color=raw_mean_color,
                                 linewidth=0.9, alpha=0.9, label="Raw",
                                 linestyle=raw_mean_linestyle, marker=raw_mean_marker,
                                 markevery=raw_mean_markevery)
            np.testing.assert_array_equal(line.get_ydata(), data["mean_time"])
            legend_items.append(line)
            visible_mean_values.append(data["mean_time"])
        if show_smoothed_mean:
            line, = ax_mean.plot(time, display_mean, color=smoothed_mean_color,
                                 linewidth=1.8, label="Smoothed",
                                 linestyle=smoothed_mean_linestyle,
                                 marker=smoothed_mean_marker,
                                 markevery=smoothed_mean_markevery)
            np.testing.assert_array_equal(line.get_ydata(), display_mean)
            legend_items.append(line)
            visible_mean_values.append(display_mean)
    else:
        # 窗口为 1 时两条数据完全相同，只画一条，避免重叠线和重复图例。
        use_smoothed_style = show_smoothed_mean
        values = display_mean if use_smoothed_style else data["mean_time"]
        color = smoothed_mean_color if use_smoothed_style else raw_mean_color
        linestyle = smoothed_mean_linestyle if use_smoothed_style else raw_mean_linestyle
        marker = smoothed_mean_marker if use_smoothed_style else raw_mean_marker
        markevery = smoothed_mean_markevery if use_smoothed_style else raw_mean_markevery
        label = "Smoothed" if use_smoothed_style and not show_raw_mean else (
            "Raw" if show_raw_mean and not show_smoothed_mean else "Mean")
        line, = ax_mean.plot(time, values, color=color, linewidth=LINE_WIDTH, label=label,
                             linestyle=linestyle, marker=marker, markevery=markevery)
        np.testing.assert_array_equal(line.get_ydata(), data["mean_time"])
        legend_items.append(line)
        visible_mean_values.append(values)
    ax_mean.legend(handles=legend_items, loc="lower left", fontsize=10,
                   ncol=min(2, len(legend_items)), framealpha=0.92)
    ax_mean.set_ylabel(mean_label, loc="center", labelpad=10)
    lo, hi = data["mean_range_requested"]
    ax_mean.set_title(rf"$r$-weighted mean, ${lo:.3g}\leq r/a\leq {hi:.3g}$", fontsize=15, pad=12)
    if settings.mean_rmin is not None or settings.mean_rmax is not None:
        # 仅用水平虚线标记平均区间，保留全径向热图，不通过平滑/遮挡改变色图结构。
        for boundary in (lo, hi):
            ax_map.axhline(boundary, color="#555555", linewidth=1.05, linestyle="--")
    # 纵轴只按当前显示的曲线与零点定范围，不因隐藏曲线留下空白。
    ymin = min(0.0, *(float(values.min()) for values in visible_mean_values))
    ymax = max(0.0, *(float(values.max()) for values in visible_mean_values))
    padding = 0.07*(ymax-ymin) if ymax > ymin else 1.0
    ax_mean.set_ylim(ymin-padding, ymax+padding)
    ax_mean.yaxis.set_major_locator(MaxNLocator(nbins=5, steps=[1, 2, 2.5, 5, 10]))
    ax_map.yaxis.set_major_locator(MaxNLocator(nbins=5, steps=[1, 2, 2.5, 5, 10]))
    ax_mean.ticklabel_format(axis="y", style="sci", scilimits=(-3, 3), useMathText=True)
    ax_mean.grid(True, linestyle="--", color="#aaaaaa", linewidth=0.8)
    # 时间窗口可选择不画；只是隐藏装饰，start/end 仍用于原始数据的窗口统计。
    for ax in (ax_map, ax_mean):
        if settings.show_time_window:
            # 仅使用浅色窗口阴影，避免显著改变热图的红蓝含义。
            ax.axvspan(start, end, color="#777777", alpha=0.10, zorder=4)
            for boundary in (start, end):
                ax.axvline(boundary, color="#333333", linestyle="--", linewidth=1.0, zorder=5)
        # 上下图同时显示选择的时段；平滑、色标和纵轴仍由完整数据确定，方便直接比较。
        ax.set_xlim(*display_limits)
        ax.set_xlabel(xlabel, loc="center", labelpad=8)
        ax.tick_params(which="major", direction="in", length=6, width=1.2, pad=6)
        ax.tick_params(which="minor", direction="in", length=3, width=0.8)
        ax.tick_params(which="both", top=True, right=True)
        ax.xaxis.set_minor_locator(AutoMinorLocator(5))
        ax.yaxis.set_minor_locator(AutoMinorLocator(4))
    visible_start, visible_end = max(start, display_limits[0]), min(end, display_limits[1])
    if settings.show_time_window and visible_start < visible_end:
        # 时间窗口在显示区间之外时不画文字；部分相交时文字置于可见区域，避免跑到图外。
        ax_map.text((visible_start+visible_end)/2, 0.965, "Averaging window", transform=ax_map.get_xaxis_transform(),
                    ha="center", va="top", fontsize=10, color="#222222", clip_on=True,
                    bbox={"facecolor": "white", "alpha": 0.75, "edgecolor": "none", "pad": 2})
    return fig


def file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024*1024), b""):
            digest.update(block)
    return digest.hexdigest()


def save_results(data, settings, header, data_path, gtc_path, output, dpi, *,
                 run_parameters=None, parameter_origins=None, profile_path=None, profile_metadata=None,
                 figure=None, figure_edits=None):
    import matplotlib.pyplot as plt

    output = result_directory(output, settings)
    data = apply_radial_average(data, settings)
    # 单独保存显示曲线；mean_time 和所有窗口统计仍基于原始数据。
    data["mean_time_display"] = smooth_mean_trace(data["mean_time"], settings.smooth_window)
    fig = figure if figure is not None else make_figure(data, settings)
    stem = ({"gamma": f"Gammai_spatiotemporal_1e19_{settings.time_axis}",
             "gammaf": f"Gammaf_spatiotemporal_1e19_{settings.time_axis}",
             "di": f"Di_spatiotemporal_{settings.units}_{settings.time_axis}",
             "df": f"Df_spatiotemporal_{settings.units}_{settings.time_axis}"}[settings.quantity]
            + variant_suffix(settings))
    saved = []
    for extension in FORMATS:
        target = output / extension.upper() / f"{stem}.{extension}"
        target.parent.mkdir(parents=True, exist_ok=True)
        fig.savefig(target, dpi=dpi, facecolor="white")
        saved.append(target.relative_to(output).as_posix())
    preview = output / "预览" / f"{stem}_preview.png"
    preview.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(preview, dpi=PREVIEW_DPI, facecolor="white")
    saved.append(preview.relative_to(output).as_posix())
    if figure is None:
        plt.close(fig)
    directory = output / "数据"
    directory.mkdir(parents=True, exist_ok=True)
    arrays = {key: value for key, value in data.items() if isinstance(value, np.ndarray)}
    data_file = directory / f"{stem}.npz"
    np.savez_compressed(data_file, **arrays)
    with np.load(data_file) as stored:
        for key, expected in arrays.items():
            np.testing.assert_array_equal(stored[key], expected)
    sources = (data_path, gtc_path) + ((profile_path,) if profile_path is not None else ())
    report = {"sources": [{"path": str(Path(p).resolve()), "sha256": file_hash(p)} for p in sources],
              "settings": asdict(settings), "parameter_origins": parameter_origins,
              "gtc_run_parameters": run_parameters, "data1d_header": header,
              "effective_window_inclusive": [data["window_start"], data["window_end"]],
              "window_mean": data["window_mean"], "coefficient_conversion_factor": data["conversion_factor"],
              "di_to_si_factor": settings.tref_ev/settings.b0,
              "particle_flux_formula": "Gamma_i = -D_i_SI * d(ni_norm * nref_19 * 1e19)/dr_m",
              "fast_particle_flux_formula": (
                  "Gamma_f = -D_f_SI * d(nf_profile_cm3 * 1e6)/dr_m"
                  if "gammaf_values" in data else None),
              "fast_density_profile": profile_metadata,
              "particle_flux_display_scale": GAMMA_DISPLAY_SCALE,
              "selected_species_1based": 3 if settings.quantity in ("df", "gammaf") else 1,
              "selected_channel_within_species_1based": 1,
              "density_gradient_scheme": "MATLAB gradient: centered secant interior, one-sided edges",
              "window_mean_drawn": False,
              "time_window_drawn": settings.show_time_window,
              "radial_resampled_on_normalized_mesh_index": data["radial_resampled"],
              "radius_interpretation": "gtc column 2 = r/R0; r/a = column2 * R0/a",
              "average_definition": "sum(selected_quantity*r in chosen radial range)/sum(r in chosen radial range); Gamma converted locally before averaging",
              "radial_average_requested_r_over_a": data["mean_range_requested"],
              "radial_average_actual_grid_r_over_a": data["mean_range_actual"],
              "radial_average_point_count": data["mean_radial_point_count"],
              "time_definition": "1-based diagnostic record * tstep; header[0] is not multiplied again",
              "time_display": {
                  "requested_R0_over_Cs": [settings.time_min, settings.time_max],
                  "effective_R0_over_Cs": list(time_display_limits(data, settings, "physical")),
                  "axis_limits": list(time_display_limits(data, settings)),
                  "scope": "x limits of both panels only; full arrays, smoothing, color scale, y limits and window statistics preserved"},
              "smoothing": {"method": "Savitzky-Golay" if settings.smooth_window > 1 else "none",
                            "window_points": settings.smooth_window, "polynomial_order": 2 if settings.smooth_window > 1 else None,
                            "window_span_R0_over_Cs": (settings.smooth_window-1)*settings.tstep,
                            "scope": "mean_time_display only; map and original arrays unchanged",
                            "original_curve_overlay": settings.smooth_window > 1,
                            "max_change_over_raw_peak_percent": float(100*np.max(np.abs(data["mean_time_display"]-data["mean_time"]))/max(np.max(np.abs(data["mean_time"])), 1e-300)),
                            "rms_change_over_raw_peak_percent": float(100*np.sqrt(np.mean((data["mean_time_display"]-data["mean_time"])**2))/max(np.max(np.abs(data["mean_time"])), 1e-300))},
              "color_limits": {"gamma": GAMMA_COLOR_LIMITS, "gammaf": GAMMAF_COLOR_LIMITS,
                               "di": COLOR_LIMITS, "df": DF_COLOR_LIMITS}[settings.quantity],
              "figure_edits": figure_edits,
              "outputs": saved}
    (directory / f"{stem}.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"records": header["records"], "shape_time_radius": list(data["values"].shape),
                      "window": report["effective_window_inclusive"], "window_mean": data["window_mean"],
                      "r_over_a_range": data["radius_a"][[0,-1]].tolist(), "settings": asdict(settings),
                      "output": str(output.resolve()), "files": saved}, ensure_ascii=True, indent=2))
    return saved


def gradient_check_data(data):
    """量化局部梯度和平均曲线的差别；拟合常数只用于诊断，绝不参与通量换算。"""
    select_quantity(data, "gamma")  # 缺少密度时明确报错。
    di_mean_si = data["di_si"] @ data["weights"]
    gamma_mean = data["gamma_mean_time"]  # 单位 10^19 m^-2 s^-1
    # 找一个常数，使 G_fit*<D> 尽量接近真正的 <Gamma>。
    # G_fit 的数值单位为 10^19 m^-4。它只是展示形状有多接近。
    denominator = float(di_mean_si @ di_mean_si)
    fitted_gradient = float(di_mean_si @ gamma_mean) / denominator if denominator > 0 else 0.0
    rescaled_di = fitted_gradient * di_mean_si
    peak = float(np.max(np.abs(gamma_mean)))
    residual_percent = 100*(gamma_mean-rescaled_di)/peak if peak > 0 else np.zeros_like(gamma_mean)
    if np.std(di_mean_si) > 0 and np.std(gamma_mean) > 0:
        correlation = float(np.corrcoef(di_mean_si, gamma_mean)[0, 1])
    else:
        correlation = None
    active = np.abs(di_mean_si) > 0.1*np.max(np.abs(di_mean_si))
    effective_gradient = gamma_mean[active]/di_mean_si[active]
    report = {
        "density_source": "gtc.out: Key profiles, meshni; equilibrium density (time independent)",
        "gradient_coordinate": "r_m = (r/R0)*R0; not r/a or normalized mesh index",
        "formula": "sum_r[-D_i_SI(t,r)*dn_i_dr(r)*r]/sum_r(r)",
        "r_over_a_range": data["radius_a"][[0, -1]].tolist(),
        "ni_m3_range": [float(np.min(data["ni_si"])), float(np.max(data["ni_si"]))],
        "minus_dni_dr_m4_range": [float(np.min(-data["grad_ni_si"])), float(np.max(-data["grad_ni_si"]))],
        "correlation_of_mean_traces": correlation,
        "fitted_constant_gradient_m4": fitted_gradient*GAMMA_DISPLAY_SCALE,
        "max_shape_residual_percent_of_gamma_peak": float(np.max(np.abs(residual_percent))),
        "active_effective_gradient_m4_range": ([float(effective_gradient.min()*GAMMA_DISPLAY_SCALE),
                                                float(effective_gradient.max()*GAMMA_DISPLAY_SCALE)]
                                               if effective_gradient.size else None),
        "active_definition": "abs(D_i_mean_SI)>0.1*max(abs(D_i_mean_SI))",
        "note": "Constant fit is a visual comparison only; actual flux uses the full local gradient.",
    }
    return report, rescaled_di, residual_percent


def save_gradient_check(data, settings, output, dpi=300):
    """另存四格核对图：密度、梯度、平均曲线对照和放大的形状差异。

    启用方法：命令行加 --check-gradient。保留已有时空图，核对图集中放在一个目录。
    """
    import matplotlib.pyplot as plt

    data = apply_radial_average(data, settings)
    report, rescaled_di, residual_percent = gradient_check_data(data)
    report["settings"] = asdict(settings)
    time = data["physical_time"] if settings.time_axis == "physical" else data["record_index"]
    xlabel = r"$t\;(R_0/C_s)$" if settings.time_axis == "physical" else "Diagnostic record"
    blue, red = "#4f75b8", "#d36b69"
    with plt.rc_context({"font.family": "sans-serif", "font.sans-serif": ["Arial", "DejaVu Sans"],
                         "font.size": 11, "axes.labelsize": 13, "axes.titlesize": 13,
                         "mathtext.fontset": "stix", "axes.linewidth": 1.2,
                         "pdf.fonttype": 42, "svg.fonttype": "none"}):
        fig, axes = plt.subplots(2, 2, figsize=(11, 7.7))
        fig.subplots_adjust(left=0.09, right=0.975, bottom=0.10, top=0.94, hspace=0.42, wspace=0.30)
        ax_n, ax_g, ax_comparison, ax_residual = axes.flat
        ax_n.plot(data["radius_a"], data["ni_si"]/1e19, color=blue, lw=1.8)
        ax_n.set(title="(a) Equilibrium ion density", xlabel=r"$r/a$", ylabel=r"$n_i\;(10^{19}\,\mathrm{m^{-3}})$")
        ax_g.plot(data["radius_a"], -data["grad_ni_si"]/1e19, color=red, lw=1.8)
        ax_g.set(title="(b) Local density gradient", xlabel=r"$r/a$", ylabel=r"$-dn_i/dr\;(10^{19}\,\mathrm{m^{-4}})$")
        ax_comparison.plot(time, data["gamma_mean_time"], color=red, lw=1.8, label=r"$\langle\Gamma_i\rangle_r$")
        ax_comparison.plot(time, rescaled_di, color="#333333", lw=1.3, ls="--", label=r"$G_{\rm fit}\langle D_i\rangle_r$")
        ax_comparison.set(title="(c) Constant-factor comparison", xlabel=xlabel,
                          ylabel=r"Flux $(10^{19}\,\mathrm{m^{-2}s^{-1}})$")
        ax_comparison.legend(loc="lower left", fontsize=11, framealpha=0.95)
        ax_comparison.text(0.98, 0.94, rf"$G_{{\rm fit}}={report['fitted_constant_gradient_m4']/1e19:.4f}\times10^{{19}}\,\mathrm{{m^{{-4}}}}$",
                           transform=ax_comparison.transAxes, ha="right", va="top", fontsize=11)
        ax_residual.plot(time, residual_percent, color=blue, lw=1.5)
        ax_residual.axhline(0, color="#777777", lw=0.8, ls="--")
        ax_residual.set(title="(d) Difference after constant scaling", xlabel=xlabel, ylabel="Residual / peak flux (%)")
        ax_residual.text(0.97, 0.95, f"Max. difference: {report['max_shape_residual_percent_of_gamma_peak']:.2f}%",
                         transform=ax_residual.transAxes, ha="right", va="top", fontsize=11,
                         bbox={"facecolor": "white", "alpha": 0.9, "edgecolor": "none"})
        for ax in (ax_n, ax_g):
            ax.set_xlim(data["radius_a"][[0, -1]])
        for ax in (ax_comparison, ax_residual):
            ax.set_xlim(time[[0, -1]])
        for ax in axes.flat:
            ax.grid(True, ls="--", color="#b8b8b8", lw=0.7)
            ax.tick_params(which="both", direction="in", top=True, right=True)
            ax.xaxis.set_minor_locator(AutoMinorLocator(4))
            ax.yaxis.set_minor_locator(AutoMinorLocator(4))
        directory = Path(output)/"梯度核对"
        directory.mkdir(parents=True, exist_ok=True)
        stem = directory/f"Di_Gammai_gradient_check_{settings.time_axis}{variant_suffix(settings)}"
        for extension in FORMATS:
            fig.savefig(stem.with_suffix("."+extension), dpi=dpi, facecolor="white")
        fig.savefig(stem.with_name(stem.name+"_preview.png"), dpi=PREVIEW_DPI, facecolor="white")
        plt.close(fig)
    stem.with_suffix(".json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Gradient check: {stem.with_suffix('.png')}")
    return report


def show_interactive(data, settings, *, on_save=None, output_dir=DEFAULT_OUTPUT):
    """同一图窗切换时间单位或四种物理量，热图、平均曲线和单位同步重画。"""
    import matplotlib.pyplot as plt
    from matplotlib.widgets import Button

    # 用同一 Figure 重建坐标框，避免只改标签却漏改热图、阴影的位置。
    fig = make_figure(data, settings)
    state = {"mode": settings.time_axis, "quantity": settings.quantity, "buttons": [],
             "settings": settings, "data": data, "save_directory": Path(output_dir)}
    quantities = [name for name in ("di", "gamma", "df", "gammaf") if f"{name}_values" in data]

    def current_settings():
        return replace(state["settings"], time_axis=state["mode"], quantity=state["quantity"])

    def add_buttons():
        button_ax = fig.add_axes([0.09, 0.012, 0.23, 0.042])
        text = "Time: record" if state["mode"] == "physical" else "Time: t (R0/Cs)"
        button = Button(button_ax, text)
        button.label.set_fontsize(10)
        button.on_clicked(toggle_time)
        quantity_ax = fig.add_axes([0.34, 0.012, 0.16, 0.042])
        next_quantity = quantities[(quantities.index(state["quantity"]) + 1) % len(quantities)]
        label = {"di": r"Show $D_i$", "gamma": r"Show $\Gamma_i$",
                 "df": r"Show $D_f$", "gammaf": r"Show $\Gamma_f$"}[next_quantity]
        quantity_button = Button(quantity_ax, label if len(quantities) > 1 else "Only $D_i$ available")
        quantity_button.label.set_fontsize(11)
        if len(quantities) > 1:
            quantity_button.on_clicked(toggle_quantity)
        range_ax = fig.add_axes([0.52, 0.012, 0.22, 0.042])
        range_button = Button(range_ax, "Range / smooth")
        range_button.label.set_fontsize(10)
        range_button.on_clicked(edit_display)
        save_ax = fig.add_axes([0.76, 0.012, 0.15, 0.042])
        save_button = Button(save_ax, "Save current")
        save_button.label.set_fontsize(10)
        if on_save is not None:
            save_button.on_clicked(save_current)
        else:
            save_button.set_active(False)
        state["buttons"] = [button, quantity_button, range_button, save_button]  # 保留控件引用。

    def refresh():
        for button in state["buttons"]:
            button.disconnect_events()
        rebuild_figure(fig, state["data"], current_settings(), state["mode"], quantity=state["quantity"])
        add_buttons()
        fig.canvas.draw_idle()

    def toggle_time(_event):
        state["mode"] = "step" if state["mode"] == "physical" else "physical"
        refresh()

    def toggle_quantity(_event):
        state["quantity"] = quantities[(quantities.index(state["quantity"]) + 1) % len(quantities)]
        refresh()

    def edit_display(_event):
        import tkinter as tk
        from tkinter import messagebox, ttk
        dialog = tk.Toplevel(fig.canvas.manager.window)
        dialog.title("径向平均、时间显示范围与平滑")
        panel = ttk.Frame(dialog, padding=16)
        panel.grid()
        entries = []
        active = current_settings()
        fields = [("平均下限 r/a（留空=数据左边界）", active.mean_rmin),
                  ("平均上限 r/a（留空=数据右边界）", active.mean_rmax),
                  ("平滑窗口（奇数；1=关闭）", active.smooth_window),
                  ("时间显示起点 t (R0/Cs；留空=首条记录)", active.time_min),
                  ("时间显示终点 t (R0/Cs；留空=末条记录)", active.time_max)]
        for row, (label, value) in enumerate(fields):
            ttk.Label(panel, text=label).grid(row=row, column=0, sticky="w", pady=5)
            entry = ttk.Entry(panel, width=18)
            entry.insert(0, "" if value is None else str(value))
            entry.grid(row=row, column=1)
            entries.append(entry)
        show_time_window = tk.BooleanVar(value=active.show_time_window)
        ttk.Checkbutton(panel, text="显示统计窗口标记（阴影、竖虚线和文字）", variable=show_time_window).grid(
            row=len(fields), column=0, columnspan=2, sticky="w", pady=5)
        lo, hi = data["radius_a"][[0, -1]]
        first, last = data["physical_time"][[0, -1]]
        ttk.Label(panel, text=f"实际网格：{lo:.6f}–{hi:.6f}；仅对区间内网格点平均。\n"
                  f"实际时间：{first:.9g}–{last:.9g} R0/Cs（共 {len(data['physical_time'])} 条记录）。\n"
                  "时间输入始终为 R0/Cs；上下图同步显示，留空恢复全时段。\n"
                  "显示范围不改变统计窗口；平滑只用于下方曲线，保留浅灰原始曲线。",
                  foreground="#555555").grid(row=len(fields)+1, column=0, columnspan=2, pady=10, sticky="w")
        def apply():
            try:
                updated = parse_display_options(active, *(entry.get() for entry in entries))
                updated = replace(updated, show_time_window=show_time_window.get())
                updated_data = apply_radial_average(state["data"], updated)
                smooth_mean_trace(updated_data["mean_time"], updated.smooth_window)
                time_display_limits(updated_data, updated)
            except ValueError as exc:
                messagebox.showerror("参数有误", str(exc), parent=dialog)
                return
            state["settings"], state["data"] = updated, updated_data
            dialog.destroy()
            refresh()
        ttk.Button(panel, text="应用并重画", command=apply).grid(row=len(fields)+2, column=1, sticky="e")
        dialog.bind("<Return>", lambda _event: apply())
        dialog.bind("<Escape>", lambda _event: dialog.destroy())
        dialog.transient(fig.canvas.manager.window)
        dialog.grab_set()

    def save_current(_event):
        from tkinter import filedialog, messagebox
        # 每次由用户选择输出根目录；取消时不写任何文件，也不改变上次保存位置。
        initial_directory = state["save_directory"].resolve()
        while not initial_directory.is_dir() and initial_directory != initial_directory.parent:
            initial_directory = initial_directory.parent
        selected = filedialog.askdirectory(
            parent=fig.canvas.manager.window,
            title="选择保存文件夹（PNG / PDF / SVG、预览及数据将按子目录保存）",
            initialdir=str(initial_directory), mustexist=False)
        if not selected:
            return
        try:
            output_path = on_save(state["data"], current_settings(), Path(selected))
        except (ValueError, OSError) as exc:
            messagebox.showerror("保存失败", str(exc), parent=fig.canvas.manager.window)
            return
        state["save_directory"] = Path(selected)
        messagebox.showinfo("已保存当前图", str(output_path), parent=fig.canvas.manager.window)

    add_buttons()
    plt.show()


def rebuild_figure(fig, data, settings, mode, *, quantity=None):
    """在现有 Figure 上重画，保持窗口和事件循环不变。"""
    make_figure(data, settings, time_axis=mode, quantity=quantity, figure=fig)


# ==================== 4. 文件/参数窗口与命令行 ====================
def choose_inputs(args):
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk

    root = tk.Tk()
    root.title("D_i / D_f / Gamma_i / Gamma_f：选择文件和参数")
    root.resizable(False, False)
    panel = ttk.Frame(root, padding=16)
    panel.grid()
    variables = {}
    detected = read_gtc_parameters(args.gtc)["inferred"] if args.gtc and args.gtc.is_file() else {}
    paths = (("gtc", "gtc.out（径向网格）"), ("data", "data1d.out（D_i / D_f）"),
             ("profile", "profile.dat（Gamma_f 所需的 n_f；其他图可留空）"))
    for row, (name, label) in enumerate(paths):
        ttk.Label(panel, text=label).grid(row=row, column=0, sticky="w", pady=4)
        variables[name] = tk.StringVar(value=str(getattr(args, name) or ""))
        ttk.Entry(panel, textvariable=variables[name], width=56).grid(row=row, column=1, sticky="ew", pady=4)
        def browse(field=name):
            filename = filedialog.askopenfilename(
                parent=root, title=f"选择 {field} 文件",
                filetypes=([("Profile", "*.dat"), ("All files", "*.*")] if field == "profile"
                           else [("GTC output", "*.out"), ("All files", "*.*")]))
            if filename:
                variables[field].set(filename)
                if field == "gtc":
                    inferred = read_gtc_parameters(filename)["inferred"]
                    for key, value in inferred.items():
                        if getattr(args, key) is None:
                            variables[key].set(str(value))
                if field in ("gtc", "data") and not variables["profile"].get().strip():
                    companion = Path(filename).with_name("profile.dat")
                    if companion.is_file():
                        variables["profile"].set(str(companion))
        ttk.Button(panel, text="浏览", command=browse).grid(row=row, column=2, padx=6)
    # 分成两个页签，增加时间范围后仍能在常见笔记本屏幕上完整显示按钮。
    notebook = ttk.Notebook(panel)
    notebook.grid(row=len(paths), column=0, columnspan=3, sticky="ew", pady=8)
    display_panel = ttk.Frame(notebook, padding=8)
    physics_panel = ttk.Frame(notebook, padding=8)
    notebook.add(display_panel, text="绘图设置（范围 / 平滑）")
    notebook.add(physics_panel, text="物理参数 / 统计窗口")
    physics_fields = [("r0", "大半径 R0 (m)"), ("a", "小半径 a (m)"),
              ("b0", "磁场 B0 (T)"), ("tref_ev", "参考温度 T_ref (eV)"),
              ("nref_19", "参考密度 (10^19 m^-3；留空自动识别)"),
              ("tstep", "每条诊断记录的时间间隔 (R0/Cs)"),
              ("start", "统计窗口起始记录（1 起算，含端点）"), ("end", "统计窗口结束记录（含端点）")]
    display_fields = [("mean_rmin", "径向平均下限 r/a（留空=数据左边界）"),
              ("mean_rmax", "径向平均上限 r/a（留空=数据右边界）"),
              ("time_min", "时间显示起点 t (R0/Cs；留空=首条记录)"),
              ("time_max", "时间显示终点 t (R0/Cs；留空=末条记录)"),
              ("smooth_window", "曲线平滑窗口（奇数，建议51；1=关闭）")]
    fields = physics_fields + display_fields
    for target_panel, target_fields in ((physics_panel, physics_fields), (display_panel, display_fields)):
        for row, (name, label) in enumerate(target_fields):
            ttk.Label(target_panel, text=label).grid(row=row, column=0, sticky="w", pady=4)
            initial = getattr(args, name)
            if initial is None:
                initial = detected.get(name, getattr(Settings(), name))
            variables[name] = tk.StringVar(value="" if initial is None else str(initial))
            ttk.Entry(target_panel, textvariable=variables[name], width=24).grid(row=row, column=1, sticky="w", pady=4)
    choices = {"quantity": ("初始显示量（di / gamma / df / gammaf）", ("di", "gamma", "df", "gammaf")),
               "units": ("D_i / D_f 单位", ("normalized", "si")),
               "time_axis": ("初始时间轴", ("physical", "step")),
               "cmap": ("配色", ("soft_bwr", "bwr", "jet", "viridis"))}
    row = len(display_fields)
    for name, (label, options) in choices.items():
        ttk.Label(display_panel, text=label).grid(row=row, column=0, sticky="w", pady=4)
        variables[name] = tk.StringVar(value=getattr(args, name))
        ttk.Combobox(display_panel, textvariable=variables[name], values=options, state="readonly", width=22).grid(row=row, column=1, sticky="w")
        row += 1
    row = len(paths)+1
    export_both = tk.BooleanVar(value=args.export_both)
    ttk.Checkbutton(panel, text="点击保存时同时导出 D_i 和 Gamma_i 两张图", variable=export_both).grid(row=row, column=0, columnspan=3, sticky="w")
    row += 1
    show_time_window = tk.BooleanVar(value=args.show_time_window)
    ttk.Checkbutton(panel, text="显示统计窗口标记（阴影、竖虚线和文字）", variable=show_time_window).grid(
        row=row, column=0, columnspan=3, sticky="w")
    row += 1
    ttk.Label(panel, text="D_i/D_f：normalized = T_ref/(eB0)，si = m²/s；Γ_i/Γ_f：10¹⁹ m⁻²s⁻¹\nD_f 需要 data1d.out 第三个物种；Γ_f 另需同算例 profile.dat 的 nf。\n径向范围决定下方平均；时间显示范围同时作用于上下图。\n时间输入始终为 R0/Cs，留空恢复全时段；与统计窗口独立。\n平滑只作用于显示曲线；启动只显示，点击 Save current 后保存。", foreground="#555555").grid(row=row, column=0, columnspan=3, sticky="w", pady=8)
    result = {}
    accepted = [False]
    def run():
        try:
            for name, _ in paths:
                entered = variables[name].get().strip()
                if name == "profile" and not entered:
                    result[name] = None
                    continue
                path = Path(entered)
                if not path.is_file():
                    raise ValueError(f"请选择有效的 {name} 文件。")
                result[name] = path
            for name, _ in fields:
                text = variables[name].get().strip()
                result[name] = (None if name in ("nref_19", "mean_rmin", "mean_rmax", "time_min", "time_max") and not text else
                                int(text) if name in ("start", "end", "smooth_window") else float(text))
            for name in choices:
                result[name] = variables[name].get()
            result["show_time_window"] = show_time_window.get()
            checked_settings = Settings(**{name: result[name] for name in Settings.__dataclass_fields__})
            checked_settings.validate()
            if checked_settings.quantity == "gammaf" and result["profile"] is None:
                raise ValueError("绘制 Gamma_f 必须选择同算例的 profile.dat（包含 nf 列）。")
            # 在关闭输入窗口前检查径向选择；输错范围可直接修改，不需要重新启动程序。
            radius, _, _ = read_gtc_profiles(result["gtc"])
            radius_m = radius*checked_settings.r0
            dummy = {"radius_a": radius_m/checked_settings.a, "radius_m": radius_m,
                     "di_values": np.zeros((1, len(radius))), "window_start": 1, "window_end": 1}
            apply_radial_average(dummy, replace(checked_settings, quantity="di"))
            if result["profile"] is not None:
                _, _, _, psi = read_gtc_profiles(result["gtc"], include_psi=True)
                run_meta = read_gtc_parameters(result["gtc"])
                read_fast_density_profile(result["profile"], psi, radius_m, run_meta["profile_psiw"],
                                          fast_electron_load=run_meta["fast_electron_load"])
            if (checked_settings.time_min is not None or checked_settings.time_max is not None
                    or checked_settings.quantity in ("df", "gammaf")):
                # 启动窗口中也检查真实时间边界，输错时保留窗口供修改；读取结果供 main 复用。
                loaded_di, loaded_df, loaded_header = read_data1d_di(result["data"], include_df=True)
                if checked_settings.quantity in ("df", "gammaf") and loaded_df is None:
                    raise ValueError("所选 data1d.out 只有两个物种，没有 D_f。请选择含第三个物种（快离子）的文件。")
                time = np.arange(1, len(loaded_di)+1, dtype=float)*checked_settings.tstep
                time_display_limits({"physical_time": time}, checked_settings)
                args._data1d_cached = (loaded_di, loaded_df, loaded_header)
        except (ValueError, OSError) as exc:
            messagebox.showerror("参数有误", str(exc), parent=root)
            return
        for name, value in result.items():
            setattr(args, name, value)
        args.export_both = export_both.get()
        accepted[0] = True
        root.destroy()
    ttk.Button(panel, text="读取数据并显示（不保存）", command=run).grid(row=row+1, column=1, sticky="w", pady=6)
    root.mainloop()
    return accepted[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, help="data1d.out 路径")
    parser.add_argument("--gtc", type=Path, help="gtc.out 路径")
    parser.add_argument("--profile", type=Path, help="profile.dat 路径；计算 Gamma_f 时必填，提供后也可在图窗中切换")
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUTPUT,
                        help="批量模式输出目录；交互模式用作保存对话框的初始位置")
    parser.add_argument("--dpi", type=int, default=EXPORT_DPI)
    parser.add_argument("--no-show", action="store_true", help="无窗口导出；须指定两个输入文件")
    parser.add_argument("--gui", action="store_true", help="即使提供文件路径，也打开左侧参数、右侧预览的一体窗口")
    for name in ("r0", "a", "b0", "tref_ev", "tstep", "nref_19"):
        parser.add_argument("--" + name.replace("_", "-"), type=float, default=None,
                            help="手动覆盖；默认自动读取 gtc.out，缺失时使用原 MATLAB 备用值")
    parser.add_argument("--start", type=int, default=DEFAULT_START)
    parser.add_argument("--end", type=int, default=DEFAULT_END)
    parser.add_argument("--mean-rmin", type=float, default=None, help="径向平均下限 r/a；默认数据左边界")
    parser.add_argument("--mean-rmax", type=float, default=None, help="径向平均上限 r/a；默认数据右边界")
    parser.add_argument("--time-min", type=float, default=None, help="两图的时间显示起点，始终以 R0/Cs 输入；默认首条记录")
    parser.add_argument("--time-max", type=float, default=None, help="两图的时间显示终点，始终以 R0/Cs 输入；默认末条记录")
    parser.add_argument("--smooth-window", type=int, default=1, help="下方曲线的 Savitzky-Golay 显示窗口（奇数；1=关闭）")
    parser.add_argument("--hide-time-window", dest="show_time_window", action="store_false", default=True,
                        help="隐藏上下图的时间窗口阴影、竖虚线及文字；不影响数据和平均计算")
    parser.add_argument("--units", choices=("normalized", "si"), default=DEFAULT_UNITS)
    parser.add_argument("--compare-kind", choices=("diffusion", "gamma"), default="diffusion",
                        help="GUI 对比模式的初始物理量：D_i/D_f 或 Gamma_i/Gamma_f")
    parser.add_argument("--quantity", choices=("di", "gamma", "df", "gammaf", "compare"), default=DEFAULT_QUANTITY,
                        help="选择 D_i、Gamma_i、D_f、Gamma_f 或 GUI 中的 D_i/D_f 对比；Gamma_f 另需 --profile")
    parser.add_argument("--export-both", action="store_true", help="保存时同时导出 D_i 和 Gamma_i；交互模式仍需点击保存")
    parser.add_argument("--check-gradient", action="store_true", help="保存时附加导出密度、梯度及平均曲线差异核对图")
    parser.add_argument("--time-axis", choices=("physical", "step"), default=DEFAULT_TIME_AXIS)
    parser.add_argument("--cmap", default=DEFAULT_CMAP)
    args = parser.parse_args()
    if args.quantity == 'compare' and not args.gui:
        parser.error('D_i/D_f 对比图请加 --gui，在一体窗口中查看和手动保存。')
    if args.no_show and (args.gui or args.data is None or args.gtc is None):
        parser.error("--no-show 模式请指定 --data 和 --gtc，且不要同时使用 --gui。")
    if not args.no_show and (args.gui or args.data is None or args.gtc is None):
        # 三个启动脚本共用一体窗口：左侧参数，右侧预览，重复重画时缓存 data1d。
        # 保留 choose_inputs / show_interactive 供旧版调用和回归核对。
        import sys
        matplotlib.use("TkAgg")
        from plot_spatiotemporal_integrated import run_integrated_gui
        run_integrated_gui(args, sys.modules[__name__])
        return
    matplotlib.use("Agg" if args.no_show else "TkAgg")
    try:
        run_parameters = read_gtc_parameters(args.gtc)
        settings, origins = resolve_settings(args, run_parameters)
        settings.validate()
        if settings.quantity == "gammaf" and args.profile is None:
            raise ValueError("Gamma_f 需要 --profile 指向同算例 profile.dat。")
        di, df, header = getattr(args, "_data1d_cached", None) or read_data1d_di(args.data, include_df=True)
        if args.profile is not None:
            radius, ni_norm, profile_columns, psi_gtc = read_gtc_profiles(args.gtc, include_psi=True)
        else:
            radius, ni_norm, profile_columns = read_gtc_profiles(args.gtc)
            psi_gtc = None
        run_parameters["profile_columns"] = profile_columns
        nf_si = grad_nf_si = fast_profile_metadata = None
        if args.profile is not None:
            nf_si, grad_nf_si, fast_profile_metadata = read_fast_density_profile(
                args.profile, psi_gtc, radius*settings.r0, run_parameters["profile_psiw"],
                fast_electron_load=run_parameters["fast_electron_load"])
        data = prepare_data(di, radius, settings, ni_norm=ni_norm, df_raw=df,
                            nf_si=nf_si, grad_nf_si=grad_nf_si)
        def export_selected(current_data, current_settings, output_path, current_origins):
            # 所有文件写入集中在这里：交互模式仅由 Save current 触发。
            if args.export_both or args.check_gradient:
                select_quantity(current_data, "gamma")
            quantities_to_save = ["di", "gamma"] if args.export_both else [current_settings.quantity]
            if current_settings.quantity not in quantities_to_save:
                quantities_to_save.append(current_settings.quantity)  # 保存按钮始终包含当前图。
            for quantity in quantities_to_save:
                save_results(current_data, replace(current_settings, quantity=quantity), header, args.data, args.gtc,
                             output_path, args.dpi, run_parameters=run_parameters,
                             parameter_origins=current_origins, profile_path=args.profile,
                             profile_metadata=fast_profile_metadata)
            if args.check_gradient:
                save_gradient_check(current_data, current_settings, output_path, args.dpi)
            # 核对图与普通图位于同一根目录的不同子目录，提示根目录方便找到所有输出。
            return (Path(output_path) if args.check_gradient else result_directory(output_path, current_settings)).resolve()

        if args.no_show:
            # 明确指定 --no-show 的命令行批量任务仍按原约定直接导出。
            export_selected(data, settings, args.out_dir, origins)
        else:
            def save_interactive(current_data, current_settings, output_path):
                current_origins = dict(origins)
                for field in ("time_axis", "quantity", "mean_rmin", "mean_rmax", "smooth_window", "show_time_window",
                              "time_min", "time_max"):
                    if getattr(current_settings, field) != getattr(settings, field):
                        current_origins[field] = "plot_window"
                return export_selected(current_data, current_settings, output_path, current_origins)
            show_interactive(data, settings, on_save=save_interactive, output_dir=args.out_dir)
    except (ValueError, OSError) as exc:
        parser.exit(1, f"出图失败：{exc}\n")


if __name__ == "__main__":
    main()
