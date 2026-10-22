#!/usr/bin/env python3
"""Extract annotated action windows from saved gameplay streams for local analysis.

Run: .tools/audio-analysis/bin/python scripts/extract-game-audio.py
Requires NumPy and FFmpeg (PATH or imageio-ffmpeg). Sources and generated files
remain ignored; this script never changes the game's audio assets.
"""
import argparse
import base64
import csv
import hashlib
import html
import io
import json
import math
from pathlib import Path
import re
import shutil
import struct
import subprocess
import wave
import zipfile

import numpy as np
from audio_processing import cosine_release

ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def float_wav(samples, rate):
    """IEEE float WAV preserves decoded samples, including codec overshoots >1."""
    channels = samples.shape[1]
    raw = samples.astype('<f4').tobytes()
    fmt = struct.pack('<HHIIHH', 3, channels, rate, rate * channels * 4, channels * 4, 32)
    body = b'WAVEfmt ' + struct.pack('<I', len(fmt)) + fmt
    body += b'fact' + struct.pack('<II', 4, len(samples))
    body += b'data' + struct.pack('<I', len(raw)) + raw
    return b'RIFF' + struct.pack('<I', len(body)) + body


def listening_wav(samples, rate, release_seconds=0):
    peak = float(np.abs(samples).max())
    gain = 10 ** (-6 / 20) / peak if peak else 1
    if release_seconds:
        samples = cosine_release(samples, rate, release_seconds, power=2)
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as handle:
        handle.setnchannels(samples.shape[1])
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(np.rint(samples * gain * 32767).astype('<i2').tobytes())
    return buffer.getvalue(), gain


def level(value):
    return round(20 * math.log10(max(float(value), 1e-12)), 3)


def waveform(samples):
    # Min/max bins retain narrow transients; both channels are shown independently.
    width, height = 720, 104
    bounds = np.linspace(0, len(samples), width + 1).astype(int)
    scale = max(float(np.abs(samples).max()), 1e-8)
    paths = []
    for channel in range(samples.shape[1]):
        center = 27 + channel * 50
        commands = []
        for index, (start, end) in enumerate(zip(bounds[:-1], bounds[1:])):
            region = samples[start:max(end, start + 1), channel]
            commands.append(f'M{index} {center - float(region.max()) / scale * 23:.2f}v{float(np.ptp(region)) / scale * 23:.2f}')
        paths.append(f'<path d="{" ".join(commands)}" stroke="{["#186d77", "#aa5730"][channel]}"/>')
    return f'<svg viewBox="0 0 {width} {height}" role="img" aria-label="Left and right channel waveform, scaled per clip"><path d="M0 27H720M0 77H720" stroke="#ccc"/>{"".join(paths)}</svg>'


def make_report(records, manifest, out):
    escape = html.escape
    cards = []
    for item in records:
        preview = base64.b64encode((out / item['listen_file']).read_bytes()).decode()
        cards.append(f'''<article data-category="{escape(item['category'])}">
<div class="tag">{escape(item['category'])} · {escape(item['isolation'])}</div>
<h2>{escape(item['label'])}</h2><p class="time">{item['start_seconds']:.3f}–{item['end_seconds']:.3f} s · {item['duration_seconds']:.3f} s · unprocessed peak {item['peak_dbfs']:.1f} dBFS</p>
{item.pop('_waveform')}<audio controls preload="none" src="data:audio/wav;base64,{preview}"></audio>
<p>{escape(item['notes'])}</p><p class="links"><a href="{escape(item['raw_file'])}" download>Unprocessed float WAV</a><a href="{escape(item['listen_file'])}" download>Listening WAV (−6 dBFS peak)</a></p>
<details><summary>Action evidence &amp; video context</summary><p>{escape(item['evidence'])}</p><video controls preload="none" src="{escape(item['context_file'])}"></video><p>Context includes neighboring sounds and uses peak-normalized AAC audio for audition. Extract starts {item['context_offset_seconds']:.3f} s into this context; video alignment is limited by the source frame rate.</p></details></article>''')
    missing = ''.join(f'<li><b>{escape(row["action"])}:</b> {escape(row["reason"])}</li>' for row in manifest['unavailable'])
    categories = sorted(set(row['category'] for row in records))
    options = ''.join(f'<option>{escape(category)}</option>' for category in categories)
    document = '''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Game action sounds</title>
<style>:root{font:16px/1.5 system-ui;color:#24312f;background:#f4f2eb}body{max-width:1120px;margin:40px auto;padding:0 20px}h1{font-size:38px;line-height:1.1;margin:10px 0}h2{font-size:20px;margin:8px 0}p{margin:10px 0}.intro{max-width:900px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:18px;margin:20px 0}article{background:white;border:1px solid #ddd9cd;border-radius:12px;padding:20px;min-width:0}.tag,.time{font-size:13px;color:#5c6961}svg,audio,video{width:100%}svg{height:100px}audio{height:42px}.links{display:flex;gap:12px;flex-wrap:wrap;font-size:13px}a{color:#126b73}details{font-size:14px;margin-top:12px}summary{cursor:pointer}button,select{font:inherit;border:1px solid #a8b2aa;background:white;border-radius:6px;padding:8px 12px;margin:12px 10px 0 0}article[hidden]{display:none}.notice{padding:16px 20px;border-left:4px solid #b88734;background:#fff9e8}footer{margin:32px 0}</style>
<div class="intro"><div class="tag">BOLTS · ACTION SOUND LIBRARY · 21 OCTOBER 2026</div><h1>Individual action sounds</h1>
<p>Listen to each action separately and use the unprocessed WAVs for measurement.</p>
<p class="notice"><b>Audio excerpts.</b> Rifle clips retain 800 ms of the shot and following audio, including decay and some early bolt handling. Ambience and overlapping effects remain. No AI replacement, denoising, EQ, time stretching, or fades have been applied to the analysis WAVs.</p>
<p><b>Analysis files:</b> 48 kHz stereo, 32-bit float WAV, original decoded samples and levels. Float preserves codec peaks above 0 dBFS without introducing clipping. <b>Players:</b> separate 16-bit copies, each peak-normalized to −6 dBFS for audition; gunshots have a stronger fade from 300 to 800 ms. Do not use listening copies to compare original loudness. Waveforms are scaled independently.</p>
<p>Playback previews are embedded in this HTML; WAV downloads and context videos work alongside the extracted package. <a href="manifest.json">Manifest</a> · <a href="measurements.csv">Measurements CSV</a></p></div>
<label>Category <select id="filter"><option value="">All actions</option>''' + options + '''</select></label><button id="stop">Stop playback</button><span id="count"></span><main class="grid">''' + ''.join(cards) + '''</main>
<section><h2>Coverage gaps</h2><p>No sample has been substituted for an action that the inspected footage cannot establish.</p><ul>''' + missing + '''</ul></section>
<footer>Clip measurements and exact sample boundaries are in manifest.json. Files are under temp/game-audio.</footer>
<script>const media=[...document.querySelectorAll('audio,video')];function stop(except){for(const m of media)if(m!==except){m.pause();m.currentTime=0;}}for(const m of media)m.addEventListener('play',()=>stop(m));document.querySelector('#stop').onclick=()=>stop();const cards=[...document.querySelectorAll('article')];function filter(){stop();const category=document.querySelector('#filter').value;for(const c of cards)c.hidden=!!category&&c.dataset.category!==category;document.querySelector('#count').textContent=cards.filter(c=>!c.hidden).length+' clips';}document.querySelector('#filter').onchange=filter;filter();</script></html>'''
    (out / 'index.html').write_text(document)


def run(args):
    manifest = json.loads(args.manifest.read_text())
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    for folder in ['raw', 'listen', 'context']:
        (out / folder).mkdir(exist_ok=True)
    ffmpeg = args.ffmpeg or shutil.which('ffmpeg')
    if not ffmpeg:
        import imageio_ffmpeg
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    names = [segment['id'] for segment in manifest['segments']]
    if len(names) != len(set(names)) or any(not re.fullmatch(r'[a-z0-9-]+', name) for name in names):
        raise ValueError('Clip IDs must be unique safe filenames')
    if any(segment['source'] not in manifest['sources'] for segment in manifest['segments']):
        raise ValueError('Unknown source in segment manifest')
    records, sources = [], {}
    for source_id, source in manifest['sources'].items():
        selected = [segment for segment in manifest['segments'] if segment['source'] == source_id]
        if not selected:
            continue
        source_path = ROOT / source['audio']
        video_path = ROOT / source['video']
        rate, channels = source['sample_rate'], source['channels']
        print(f'Decoding {source_id} from original compressed stereo stream', flush=True)
        result = subprocess.run([ffmpeg, '-hide_banner', '-i', str(source_path), '-map', '0:a:0', '-f', 'f32le', '-c:a', 'pcm_f32le', '-'], check=True, capture_output=True)
        if f'{rate} Hz, stereo' not in result.stderr.decode():
            raise ValueError('Source format differs from annotated sample rate/channel layout')
        samples = np.frombuffer(result.stdout, dtype='<f4').reshape(-1, channels)
        if not np.isfinite(samples).all():
            raise ValueError('Source contains non-finite decoded samples')
        sources[source_id] = {'sample_rate': rate, 'channels': channels, 'audio_sha256': digest(source_path), 'video_sha256': digest(video_path), 'decoded_frames': len(samples), 'duration_seconds': len(samples) / rate}
        for segment in selected:
            start, end = round(segment['start'] * rate), round(segment['end'] * rate)
            if not 0 <= start < end <= len(samples):
                raise ValueError(f'Invalid sample interval: {segment["id"]}')
            clip = samples[start:end]
            raw = float_wav(clip, rate)
            # Readback proves exact preservation of every decoded float sample.
            if not np.array_equal(np.frombuffer(raw[56:], dtype='<f4').reshape(-1, channels), clip):
                raise ValueError('Raw WAV did not preserve source samples')
            release_seconds = .5 if segment['category'] == 'Rifle reports' else 0
            preview, gain = listening_wav(clip, rate, release_seconds)
            name = segment['id']
            raw_path, listen_path, context_path = f'raw/{name}.wav', f'listen/{name}.wav', f'context/{name}.mp4'
            (out / raw_path).write_bytes(raw)
            (out / listen_path).write_bytes(preview)
            context_start = max(0, segment['start'] - .4)
            context_end = min(len(samples) / rate, segment['end'] + .45)
            # Sample slicing avoids Opus/container seek offsets (~8 ms here).
            # Context is an audition proxy; only raw WAVs are measurement data.
            context_audio, context_gain = listening_wav(samples[round(context_start * rate):round(context_end * rate)], rate)
            subprocess.run([ffmpeg, '-v', 'error', '-y', '-ss', str(context_start), '-i', str(video_path), '-f', 'wav', '-i', 'pipe:0', '-map', '0:v:0', '-map', '1:a:0', '-t', str(context_end - context_start), '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', str(out / context_path)], input=context_audio, check=True)
            item = {**segment, 'start_sample': start, 'end_sample_exclusive': end, 'start_seconds': start / rate, 'end_seconds': end / rate, 'sample_rate': rate, 'channels': channels, 'frames': end - start, 'duration_seconds': (end - start) / rate, 'raw_format': 'IEEE float32 WAV', 'peak_dbfs': level(np.abs(clip).max()), 'rms_dbfs': level(np.sqrt(np.mean(clip.astype(float) ** 2))), 'samples_above_full_scale': int(np.sum(np.abs(clip) > 1)), 'listen_gain_db': level(gain), 'raw_file': raw_path, 'listen_file': listen_path, 'context_file': context_path, 'context_start_seconds': context_start, 'context_offset_seconds': segment['start'] - context_start, 'raw_sha256': hashlib.sha256(raw).hexdigest(), 'sample_preservation_verified': True, '_waveform': waveform(clip)}
            records.append(item)
            item['context_gain_db'] = level(context_gain)
            item['listen_release_seconds'] = release_seconds
            item['listen_release_curve'] = 'squared raised cosine' if release_seconds else 'none'
            print(f'  {name}: {item["duration_seconds"]:.3f} s', flush=True)
        del samples, result
    make_report(records, manifest, out)
    report = {'method': 'Sample-accurate temporal cuts of decoded game-video stereo mix. Analysis WAVs have no source separation, denoising, EQ, fading, resampling or time compression. Listening copies use a fixed per-clip gain and PCM16 quantization; gunshots have a 500 ms squared raised-cosine release beginning at 300 ms.', 'raw_sample_format': 'IEEE float32, 48 kHz, stereo', 'ffmpeg_version': subprocess.check_output([ffmpeg, '-version'], text=True).splitlines()[0], 'annotation_sha256': digest(args.manifest), 'sources': sources, 'clips': records, 'unavailable': manifest['unavailable']}
    (out / 'manifest.json').write_text(json.dumps(report, indent=2) + '\n')
    columns = ['id', 'category', 'label', 'source', 'start_seconds', 'end_seconds', 'duration_seconds', 'frames', 'peak_dbfs', 'rms_dbfs', 'samples_above_full_scale', 'listen_gain_db', 'isolation', 'raw_file', 'notes']
    with (out / 'measurements.csv').open('w', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(records)
    with zipfile.ZipFile(out / 'game-action-sounds.zip', 'w', zipfile.ZIP_DEFLATED) as bundle:
        for filename in ['index.html', 'manifest.json', 'measurements.csv']:
            bundle.write(out / filename, filename)
        for item in records:
            for key in ['raw_file', 'listen_file', 'context_file']:
                bundle.write(out / item[key], item[key])
    print(f'Saved {len(records)} clips; open {out / "index.html"}', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, default=ROOT / 'scripts/game-audio-segments.json')
    parser.add_argument('--out', type=Path, default=ROOT / 'temp/game-audio')
    parser.add_argument('--ffmpeg')
    run(parser.parse_args())
