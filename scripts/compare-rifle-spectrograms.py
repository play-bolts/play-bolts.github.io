#!/usr/bin/env python3
"""Multi-shot, phase-specific reference analysis. All recordings stay in artifacts.
Requires numpy/matplotlib; run export-rifle-synthesis.ts before this script.
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
STARTS={'british':[327.316,329.043,332.385],'russian':[235.265,237.066,242.049],'german':[252.441,253.870,258.229]}
PHASES={'attack':(0,.025),'body':(.025,.14),'tail':(.14,.35)}
BANDS=[(60,250),(250,700),(700,1800),(1800,4000),(4000,12000)]
EDGES=np.geomspace(60,12000,25)
LABELS={'british':'Lee–Enfield','russian':'Mosin–Nagant','german':'Kar98k'}

def stft(signal,rate):
    size=1024;hop=128;pad=size//2;x=np.pad(signal,(pad,pad));starts=np.arange(0,len(signal),hop)
    power=np.asarray([np.abs(np.fft.rfft(x[start:start+size]*np.hanning(size)))**2 for start in starts]).T
    return np.fft.rfftfreq(size,1/rate),starts/rate,power

def envelope(signal,rate):
    width=round(rate*.005);out=np.sqrt(np.mean(signal[:len(signal)//width*width].reshape(-1,width)**2,axis=1))
    return out/max(out.max(),1e-9)

def metrics(signal,rate):
    phases={}
    for name,(start,end) in PHASES.items():
        x=signal[round(start*rate):round(end*rate)];frequencies=np.fft.rfftfreq(len(x),1/rate)
        power=np.abs(np.fft.rfft(x*np.hanning(len(x))))**2;valid=(frequencies>=60)&(frequencies<12000);power/=power[valid].sum()
        fine=[float(power[(frequencies>=a)&(frequencies<b)].sum()) for a,b in zip(EDGES[:-1],EDGES[1:])]
        phases[name]={'centroid_hz':float((frequencies[valid]*power[valid]).sum()),'bands_percent':[float(power[(frequencies>=a)&(frequencies<b)].sum()*100) for a,b in BANDS],
                      'log_bands_db':(10*np.log10(np.maximum(fine,1e-8))).tolist(),'rms':float(np.sqrt(np.mean(x*x)))}
    env=envelope(signal,rate);phases['body_to_attack_db']=20*np.log10(phases['body']['rms']/phases['attack']['rms']);phases['tail_to_body_db']=20*np.log10(phases['tail']['rms']/phases['body']['rms'])
    # Relative 5ms envelope variation after removing a 35ms moving mean is a coarse roughness descriptor.
    smooth=np.convolve(env,np.ones(7)/7,mode='same');relative=env[4:-4]/np.maximum(smooth[4:-4],1e-5)
    phases['envelope_roughness']=float(np.std(relative));phases['envelope_db']=(20*np.log10(np.maximum(env,1e-5))).tolist()
    return phases

def main():
    p=argparse.ArgumentParser();p.add_argument('--directory',type=Path,default=Path('artifacts/audio-reference'));args=p.parse_args();directory=args.directory
    reference,rate=measure.read(directory/'firing.wav');length=round(.35*rate);result={};signals={}
    for faction,starts in STARTS.items():
        refs=[reference[round(t*rate):round(t*rate)+length] for t in starts]
        signals[faction]={'reference':refs,'before':[],'after':[]}
        for variant in range(3):
            suffix=f'-v{variant}' if variant else ''
            before,before_rate=measure.read(directory/'before-spectrogram'/f'{faction}-synth{suffix}.wav');after,after_rate=measure.read(directory/f'{faction}-synth{suffix}.wav');assert rate==before_rate==after_rate
            signals[faction]['before'].append(before[:length]);signals[faction]['after'].append(after[:length])
        items={name:[metrics(x,rate) for x in samples] for name,samples in signals[faction].items()}
        ref_band=np.mean([[r[phase]['log_bands_db'] for phase in PHASES] for r in items['reference']],axis=0)
        ref_env=np.mean([r['envelope_db'] for r in items['reference']],axis=0)
        items['error']={}
        for name in ['before','after']:
            band=np.mean([[m[phase]['log_bands_db'] for phase in PHASES] for m in items[name]],axis=0);env=np.mean([m['envelope_db'] for m in items[name]],axis=0)
            items['error'][name]={'phase_band_mae_db':float(np.mean(np.abs(band-ref_band))),'envelope_mae_db':float(np.mean(np.abs(env-ref_env)))}
        result[faction]={'onsets':starts,**items}
    (directory/'spectrogram-measurements.json').write_text(json.dumps(result,indent=2)+'\n')
    fig,axes=plt.subplots(3,3,figsize=(14,10),layout='constrained')
    for row,(faction,label) in enumerate(LABELS.items()):
        for col,name in enumerate(['reference','before','after']):
            spectra=[]
            for signal in signals[faction][name]:
                f,t,power=stft(signal/np.sqrt(np.mean(signal**2)),rate);spectra.append(power)
            power=np.median(spectra,axis=0);db=10*np.log10(np.maximum(power,1e-12));db-=db.max()
            axes[row,col].pcolormesh(t*1000,f,db,vmin=-48,vmax=0,cmap='magma',shading='auto',rasterized=True)
            axes[row,col].set(yscale='log',ylim=(60,12000),xlim=(0,350),xlabel='Time after onset (ms)',ylabel='Frequency (Hz)',title=f'{label}: {name} (median, n=3)')
            axes[row,col].axvline(25,color='white',lw=.6,alpha=.5);axes[row,col].axvline(140,color='white',lw=.6,alpha=.5)
    fig.suptitle('CoD1/UO rifle time–frequency comparison: 21.3 ms Hann STFT, 2.67 ms hop\nOriginal synthesized noise/resonances only; reference cutoff 350 ms excludes later bolt and reload sounds')
    fig.savefig(directory/'rifle-spectrograms.png',dpi=150);fig.savefig(directory/'rifle-spectrograms.svg')
    fig,axes=plt.subplots(3,2,figsize=(12,9),layout='constrained')
    for row,(faction,label) in enumerate(LABELS.items()):
        refs=np.asarray([x['envelope_db'] for x in result[faction]['reference']]);times=np.arange(refs.shape[1])*5+2.5
        axes[row,0].fill_between(times,refs.min(axis=0),refs.max(axis=0),color='#333333',alpha=.15)
        axes[row,0].plot(times,refs.mean(axis=0),label='reference mean/range',color='#222222')
        for name,color in [('before','#8c8ca6'),('after','#b44913')]:axes[row,0].plot(times,np.mean([m['envelope_db'] for m in result[faction][name]],axis=0),label=name,color=color)
        axes[row,0].set(title=label+' envelope',xlabel='Time (ms)',ylabel='Relative RMS (dB)',xlim=(0,350),ylim=(-28,2));axes[row,0].legend()
        for name,color in [('reference','#222222'),('before','#8c8ca6'),('after','#b44913')]:
            values=np.mean([[x[phase]['centroid_hz'] for phase in PHASES] for x in result[faction][name]],axis=0);axes[row,1].plot(list(PHASES),values,'o-',label=name,color=color)
        axes[row,1].set(title=label+' phase centroid',ylabel='Frequency (Hz)',ylim=(0,5500));axes[row,1].legend()
        for axis in axes[row]:axis.grid(alpha=.2)
    fig.suptitle('Attack 0–25 ms / body 25–140 ms / tail 140–350 ms; multiple visually verified shots')
    fig.savefig(directory/'rifle-phase-comparison.png',dpi=150)
    for faction,items in result.items():
        print(faction,items['error'])
        for name in ['reference','before','after']:
            print(name,{'centroids':[round(float(np.mean([x[phase]['centroid_hz'] for x in items[name]]))) for phase in PHASES],
                        'body_attack_db':round(float(np.mean([x['body_to_attack_db'] for x in items[name]])),2),'tail_body_db':round(float(np.mean([x['tail_to_body_db'] for x in items[name]])),2),
                        'roughness':round(float(np.mean([x['envelope_roughness'] for x in items[name]])),3)})
if __name__=='__main__':main()
