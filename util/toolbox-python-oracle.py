"""Development-only oracle for checking the JS port against real GTC files."""
import argparse
from dataclasses import asdict
import importlib.util
import json
from pathlib import Path
import sys
sys.dont_write_bytecode = True

parser = argparse.ArgumentParser()
parser.add_argument('--case', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('oracle', root / 'python-tools/di-spatiotemporal/plot_Di_spatiotemporal.py')
d = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = d
spec.loader.exec_module(d)
di, df, header = d.read_data1d_di(args.case / 'data1d.out', include_df=True)
radius, ni, _, psi = d.read_gtc_profiles(args.case / 'gtc.out', include_psi=True)
run = d.read_gtc_parameters(args.case / 'gtc.out')
metadata = []
with (args.output / 'expected.f64').open('wb') as out:
    offset = 0
    for units in ('normalized', 'si'):
        settings = d.Settings(**run['inferred'], units=units, start=1 if len(di) < 1600 else 1600,
                              end=min(len(di), 2000), smooth_window=min(51, len(di) if len(di) % 2 else len(di)-1))
        nf = grad = None
        if (args.case / 'profile.dat').exists():
            nf, grad, _ = d.read_fast_density_profile(args.case / 'profile.dat', psi, radius*settings.r0,
                                                     run['profile_psiw'], fast_electron_load=run['fast_electron_load'])
        prepared = d.prepare_data(di, radius, settings, ni_norm=ni, df_raw=df, nf_si=nf, grad_nf_si=grad)
        for quantity in ('di', 'df', 'gamma', 'gammaf'):
            if quantity + '_values' not in prepared:
                continue
            selected = d.select_quantity(prepared, quantity)
            arrays = {'values': selected['values'], 'mean': selected['mean_time'],
                      'smooth': d.smooth_mean_trace(selected['mean_time'], settings.smooth_window),
                      'window_profile_mean': selected['window_profile_mean'],
                      'weights': selected['weights'], 'radius_a': selected['radius_a']}
            descriptors = {}
            for name, values in arrays.items():
                values = values.astype('<f8').ravel()
                descriptors[name] = {'offset': offset, 'length': values.size}
                out.write(values.tobytes())
                offset += values.size
            metadata.append({'settings': {**asdict(settings), 'quantity': quantity},
                             'window_mean': selected['window_mean'], 'arrays': descriptors})
(args.output / 'expected.json').write_text(json.dumps(metadata), encoding='utf-8')
