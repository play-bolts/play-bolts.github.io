#!/usr/bin/env python3
"""Local contact sheets and envelopes for action-reference timing inspection."""
import json
import os
import subprocess
import wave
from pathlib import Path

import imageio_ffmpeg
import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'temp/game-audio-reference/bolt-inspection'
OUT.mkdir(parents=True, exist_ok=True)
os.environ['MPLCONFIGDIR'] = str(OUT / 'matplotlib-cache')
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

STARTS = {'enfield': 327.316, 'mosin': 235.265, 'kar98k': 252.441}
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
with wave.open(str(ROOT / 'artifacts/audio-reference/firing.wav'), 'rb') as source:
    rate = source.getframerate()
    samples = np.frombuffer(source.readframes(source.getnframes()), dtype='<i2').reshape(-1, source.getnchannels()).mean(axis=1) / 32768

measurements = {}
for name, onset in STARTS.items():
    start = onset - .05
    frames = OUT / name
    frames.mkdir(exist_ok=True)
    subprocess.run([FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', '-ss', str(start), '-i', str(ROOT / 'artifacts/audio-reference/firing-video.mp4'), '-t', '1.8', '-vf', 'fps=10,scale=384:-1', str(frames / '%02d.jpg')], check=True)
    images = list(sorted(frames.glob('*.jpg')))
    width, height = Image.open(images[0]).size
    sheet = Image.new('RGB', (4 * width, 5 * (height + 28)), '#eee')
    draw = ImageDraw.Draw(sheet)
    for index, path in enumerate(images):
        x, y = (index % 4) * width, (index // 4) * (height + 28)
        sheet.paste(Image.open(path), (x, y + 28))
        draw.text((x + 8, y + 7), f'{name} approx {start + .1 * index:.3f}s (+{.1*index-.05:.2f}s)', fill='#111')
    sheet.save(OUT / f'{name}-contact-sheet.png')
    detail_offsets = [.6, .65, .7, .75, .8, .9, 1., 1.1, 1.2]
    detail_sheet = Image.new('RGB', (3 * 512, 3 * (288 + 28)), '#eee')
    detail_draw = ImageDraw.Draw(detail_sheet)
    for index, offset in enumerate(detail_offsets):
        timestamp = onset + offset
        path = frames / f'detail-{index}.png'
        subprocess.run([FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', '-ss', str(timestamp), '-i', str(ROOT / 'artifacts/audio-reference/firing-video.mp4'), '-frames:v', '1', '-vf', 'scale=512:288', str(path)], check=True)
        x, y = (index % 3) * 512, (index // 3) * 316
        detail_sheet.paste(Image.open(path), (x, y + 28))
        detail_draw.text((x + 8, y + 7), f'{name} seek {timestamp:.3f}s (+{offset:.2f}s)', fill='#111')
    detail_sheet.save(OUT / f'{name}-bolt-detail.png')
    segment = samples[round(start*rate):round((start+1.8)*rate)]
    win = round(rate * .005)
    rms = np.sqrt(np.mean(segment[:len(segment)//win*win].reshape(-1,win)**2, axis=1))
    db = 20*np.log10(np.maximum(rms, 1e-8))
    times = start + (np.arange(len(db))+.5)*.005
    peaks = []
    for index in np.argsort(rms)[::-1]:
        if times[index] < onset + .3:
            continue
        if all(abs(times[index]-t)>.07 for t, _ in peaks):
            peaks.append((float(times[index]), float(db[index])))
        if len(peaks) >= 12:
            break
    measurements[name] = {'shot_onset':onset,'post_shot_peaks':sorted(peaks)}
    fig, ax = plt.subplots(figsize=(15,4))
    ax.plot(times,db,lw=1)
    ax.axvline(onset,color='red',label='Shot onset')
    ax.axvline(onset+.35,color='orange',label='Current 350ms analysis cutoff')
    ax.set(title=f'{name}: 5ms RMS envelope',xlabel='Source seconds',ylabel='RMS dBFS',ylim=(-65,0))
    ax.set_xticks(np.arange(np.floor(start*10)/10,start+1.8,.1))
    ax.grid(alpha=.3)
    ax.legend()
    fig.tight_layout()
    fig.savefig(OUT/f'{name}-envelope.png',dpi=120)
    plt.close(fig)
(OUT/'measurements.json').write_text(json.dumps(measurements,indent=2)+'\n')
print(json.dumps(measurements,indent=2))
