#!/usr/bin/env python3
"""Compare ignored local reference recordings with original Bolts synthesis.
First run export-rifle-synthesis.ts, then use the same directory for --directory.
Only numeric measurements and plots are written; no audio is copied into assets.
"""
import argparse,importlib.util,json,os
from pathlib import Path
os.environ.setdefault('MPLCONFIGDIR','artifacts/audio-reference/matplotlib-cache')
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
spec=importlib.util.spec_from_file_location('measure',Path(__file__).with_name('analyze-rifle-audio.py'))
measure=importlib.util.module_from_spec(spec);spec.loader.exec_module(measure)
p=argparse.ArgumentParser();p.add_argument('--directory',type=Path,default=Path('artifacts/audio-reference'));args=p.parse_args();directory=args.directory
reference,rate=measure.read(directory/'firing.wav')
results={}
for faction,start in {'british':327.316,'russian':235.267,'german':252.440}.items():
    results[faction]={'reference':measure.metrics(reference,rate,start),'synthesis':measure.metrics(*measure.read(directory/f'{faction}-synth.wav'),0)}
results['multiplayer_mosin']=measure.metrics(*measure.read(directory/'multiplayer.wav'),137.380)
(directory/'measurements.json').write_text(json.dumps(results,indent=2)+'\n')
summary={f:{kind:{k:v for k,v in item.items() if not k.startswith(('envelope_','spectrum_'))} for kind,item in variants.items()} for f,variants in results.items() if f!='multiplayer_mosin'}
summary['multiplayer_mosin']={k:v for k,v in results['multiplayer_mosin'].items() if not k.startswith(('envelope_','spectrum_'))}
(directory/'measurement-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
fig,axes=plt.subplots(3,2,figsize=(12,10),layout='constrained')
labels={'british':'Lee–Enfield','russian':'Mosin–Nagant','german':'Kar98k'}
for row,(faction,label) in enumerate(labels.items()):
    for kind,color in [('reference','#333333'),('synthesis','#b44913')]:
        item=results[faction][kind];env=np.asarray(item['envelope_5ms']);axes[row,0].plot(np.arange(len(env))*5+2.5,20*np.log10(np.maximum(env,1e-4)),label=kind,color=color)
        db=np.asarray(item['spectrum_db']);hz=np.arange(len(db))*item['spectrum_hz_step']
        # Average power into octave-fraction bins to expose broad spectral shape instead of random FFT teeth.
        edges=np.geomspace(60,12000,70);centers=np.sqrt(edges[:-1]*edges[1:]);power=10**(db/10)
        smooth=np.asarray([power[(hz>=a)&(hz<b)].mean() if np.any((hz>=a)&(hz<b)) else np.nan for a,b in zip(edges[:-1],edges[1:])])
        axes[row,1].semilogx(centers,10*np.log10(smooth/np.nanmax(smooth)),label=kind,color=color)
    axes[row,0].set(title=label+' — envelope',xlabel='Time after onset (ms)',ylabel='Relative RMS (dB)',xlim=(0,500),ylim=(-45,2))
    axes[row,1].set(title=label+' — first 160 ms spectrum',xlabel='Frequency (Hz)',ylabel='Relative power (dB)',xlim=(60,12000),ylim=(-40,2))
    for axis in axes[row]:axis.grid(alpha=.2);axis.legend(loc='lower left')
fig.suptitle('Bolts original synthesis vs visually verified CoD1/UO firing footage\nSingle-shot examples; encoded recording and environment affect the reference')
fig.savefig(directory/'rifle-comparison.png',dpi=150);fig.savefig(directory/'rifle-comparison.svg')
print(json.dumps(summary,indent=2))
