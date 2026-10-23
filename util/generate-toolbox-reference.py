"""Regenerate small numeric fixtures using the original Python scientific core.

Development only; neither this generator nor Python is shipped in the release.
"""
import importlib.util
import json
from pathlib import Path
import sys
sys.dont_write_bytecode = True
import tempfile
from dataclasses import asdict
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("di_reference", ROOT / "python-tools/di-spatiotemporal/plot_Di_spatiotemporal.py")
core = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = core
spec.loader.exec_module(core)

gtc = """R0 = 200
B0 = 20000
ETEMP0 = 900
ETEMP0 = 1200
EDEN0 = 2e13
density profiles normalized to on-axis electron value.
TSTEP = 0.01
NDIAG = 4
at last closed flux surface a_minor = 0.4
more eqdata: ped,psiw,rmaj= 0.1 2.0 1.0
FLOAD = 1
FELOAD = 0
Key profiles on radial mesh:
i r psi Te Ti meshne meshni q
1 0.00 0.0 1 1 1.0 2.0 1
2 0.06 0.1 1 1 0.9 1.7 1
3 0.14 0.4 1 1 0.8 1.4 1
4 0.23 1.2 1 1 0.7 0.8 1
5 0.31 2.0 1 1 0.6 0.2 1
another table:
1 99 99 99 99 99 99 99
"""
profile = "pol-flux nf r\n0 4e13 0\n0.3 3.2e13 0\n0.8 1.7e13 0\n1 1e13 0\n"
header = [5000, 4, 3, 0, 2, 1, 1]
frames = np.full((9, 7, 4), 9999.0)
for t in range(9):
    for r in range(4):
        frames[t, 0, r] = (np.sin((t + 1) * .7) + (r - .8) * .3) * 1e-4
        frames[t, 4, r] = (np.cos((t + 1) * .4) * 1.2 + r * .7) * 1e-3
data_text = "\n".join(map(str, header)) + "\n" + "\n".join(f"{v:.17e}".replace("e", "D") for v in frames.ravel()) + "\n1 2 3\n"

fixture = {"reference": "Di_spatiotemporal_python; float64; MATLAB gradient; scipy savgol_filter(mode=interp)",
           "inputs": {"gtc": gtc, "data": data_text, "profile": profile}, "cases": []}
with tempfile.TemporaryDirectory() as temporary:
    directory = Path(temporary)
    for name, content in (("gtc.out", gtc), ("data1d.out", data_text), ("profile.dat", profile)):
        (directory / name).write_text(content, encoding="utf-8")
    di, df, _ = core.read_data1d_di(directory / "data1d.out", include_df=True)
    radius, ni, _, psi = core.read_gtc_profiles(directory / "gtc.out", include_psi=True)
    run = core.read_gtc_parameters(directory / "gtc.out")
    for quantity in ("di", "df", "gamma", "gammaf"):
        for units in ("normalized", "si"):
            settings = core.Settings(**run["inferred"], quantity=quantity, units=units,
                                     start=2, end=7, mean_rmin=.1, mean_rmax=.6,
                                     time_min=.04, time_max=.28, time_axis="step" if units == "si" else "physical",
                                     smooth_window=9 if units == "si" else 5)
            nf, grad, _ = core.read_fast_density_profile(directory / "profile.dat", psi, radius * settings.r0, run["profile_psiw"], fast_electron_load=0)
            prepared = core.prepare_data(di, radius, settings, ni_norm=ni, df_raw=df, nf_si=nf, grad_nf_si=grad)
            expected = {key: prepared[key].tolist() for key in ("values", "mean_time", "window_profile_mean", "weights", "radius_a", "radius_m", "physical_time", "ni_si", "grad_ni_si", "nf_si", "grad_nf_si")}
            expected["smooth"] = core.smooth_mean_trace(prepared["mean_time"], settings.smooth_window).tolist()
            expected["window_mean"] = prepared["window_mean"]
            expected["time_range"] = core.time_display_limits(prepared, settings)
            fixture["cases"].append({"settings": asdict(settings), "expected": expected})
destination = ROOT / "test/fixtures/spatiotemporal-python.json"
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(destination)
