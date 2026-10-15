#!/usr/bin/env python3
"""Local-only reference measurement. Requires numpy; never copies recordings into assets.

Usage: python scripts/analyze-rifle-audio.py mono.wav --starts 73.82 84.23 --label rifle
All spectra use a 160 ms onset window, Hann window, and power weighting.
"""
import argparse,json,wave
from pathlib import Path
import numpy as np

def read(path):
    with wave.open(str(path),'rb') as f:
        assert f.getsampwidth()==2,'Decode to signed PCM16 WAV first'
        rate=f.getframerate()
        data=np.frombuffer(f.readframes(f.getnframes()),dtype='<i2').astype(float)/32768
        return data.reshape(-1,f.getnchannels()).mean(axis=1),rate

def metrics(data,rate,start):
    signal=data[round(start*rate):round((start+.65)*rate)]
    signal=signal-signal.mean()
    n=min(len(signal),round(.16*rate))
    frequencies=np.fft.rfftfreq(n,1/rate)
    spectrum=np.abs(np.fft.rfft(signal[:n]*np.hanning(n)))**2
    useful=(frequencies>=60)&(frequencies<12000)
    total=spectrum[useful].sum()
    bands=[(60,500),(500,2000),(2000,6000),(6000,12000)]
    centroid=float((frequencies[useful]*spectrum[useful]).sum()/total)
    width=round(.005*rate)
    envelope=np.sqrt(np.mean(signal[:len(signal)//width*width].reshape(-1,width)**2,axis=1))
    peak=int(np.argmax(envelope))
    # Continuous decay estimates can be truncated by later bolt/footstep/background sounds.
    below=np.flatnonzero(envelope[peak:]<envelope[peak]*.1)
    cumulative=np.cumsum(signal*signal)
    energy95=float(np.searchsorted(cumulative,cumulative[-1]*.95)/rate)
    return {'start_seconds':round(start,6),'centroid_hz':round(centroid,1),
            'band_energy_percent':{f'{lo}-{hi}':round(float(spectrum[(frequencies>=lo)&(frequencies<hi)].sum()/total*100),2) for lo,hi in bands},
            'peak_ms':round((peak+.5)*5,1),'decay_20db_ms':int(below[0]*5) if len(below) else None,
            'energy95_ms':round(energy95*1000,1),'rms':round(float(np.sqrt(np.mean(signal*signal))),5),
            'envelope_5ms':[round(float(x/envelope[peak]),5) for x in envelope],
            'spectrum_db':[round(float(x),2) for x in 10*np.log10(np.maximum(spectrum,1e-16)/max(spectrum.max(),1e-16))],
            'spectrum_hz_step':rate/n}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('wav',type=Path);p.add_argument('--starts',type=float,nargs='+');p.add_argument('--label',default='reference');p.add_argument('--scan',nargs=2,type=float)
    args=p.parse_args();data,rate=read(args.wav)
    if args.scan:
        low,high=args.scan;window=round(rate*.005);region=data[round(low*rate):round(high*rate)]
        env=np.sqrt(np.mean(region[:len(region)//window*window].reshape(-1,window)**2,axis=1))
        peaks=[]
        for idx in np.argsort(env)[::-1]:
            t=low+idx*.005
            if all(abs(t-prior[0])>.65 for prior in peaks):peaks.append((round(t,3),round(float(env[idx]),5)))
            if len(peaks)>=12:break
        print(json.dumps({'peaks':sorted(peaks)},indent=2))
    else: print(json.dumps({'label':args.label,'source':str(args.wav),'sample_rate':rate,'shots':[metrics(data,rate,s) for s in args.starts]},indent=2))
