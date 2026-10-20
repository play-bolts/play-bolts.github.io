#!/usr/bin/env python3
"""Generate finite, resumable Stability sound candidates, never from the browser.

Run with .tools/audio-analysis/bin/python (NumPy + modern TLS). By default this
prints the fixed job plan. --generate makes paid requests for missing jobs only.
Keys come from STABILITY_API_KEY or the explicitly requested ~/zshrc, and never
appear in saved requests, public assets, errors, or command-line arguments.
"""
import argparse
import ast
from concurrent.futures import ThreadPoolExecutor, as_completed
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import re
import threading
import time
import urllib.error
import urllib.request
import uuid
import numpy as np
from audio_processing import read_wav, wav_bytes, compress_time

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / 'temp/stability-audio'
PUBLIC = ROOT / 'public/assets/audio/candidates'
MANIFEST = ROOT / 'shared/audio-candidates.json'
MODEL = 'stable-audio-3'
PROCESSING_VERSION = 4
BASE = 'https://api.stability.ai'
PROFILES = [
    ('warm', 'Warm & full', 'Warm low-mid weight, natural body, restrained brittle high frequencies.', .18),
    ('crisp', 'Crisp & detailed', 'Clean physical detail, tight clear attack, rich natural texture without thin metallic ringing.', .32),
    ('gritty', 'Gritty & powerful', 'Weighty raw realism, textured organic grit, powerful body and compact dry decay.', .46),
]
# Two high-strength effects developed long continuous tails. Replacement takes
# keep the same requested texture with more of the original transient structure.
JOB_OVERRIDES = {
    'movement-stand-gritty': {'strength': .26, 'seed': 681170},
    'combat-shot-impact-gritty': {'strength': .24, 'seed': 681171},
}
DESCRIPTIONS = {
    ('rifle', 'british'): 'One isolated Lee-Enfield bolt-action rifle shot. Balanced warm thump followed by a clear sharp crack.',
    ('rifle', 'russian'): 'One isolated Mosin-Nagant bolt-action rifle shot. The deepest, heaviest low-bodied thump of the three rifle sounds, with a sharp attack.',
    ('rifle', 'german'): 'One isolated Kar98k bolt-action rifle shot. The brightest sharpest crack of the three rifle sounds, a compact heavy midrange body.',
    ('movement', 'stand'): 'One isolated walking boot footstep on dry packed earth and stone, heel-to-toe weight, subtle grit and leather clothing texture.',
    ('movement', 'crouch'): 'One isolated cautious crouching boot footstep, soft weighted sole contact and a brief cloth and dirt scrape, quieter than ordinary walking.',
    ('movement', 'prone'): 'One isolated prone crawling contact, a short grounded cloth, leather and dirt scrape, subdued low contact weight.',
    ('combat', 'swing'): 'One isolated fast rifle-butt melee swing through air, a compact cloth and wood whoosh without a hit.',
    ('combat', 'shot-impact'): 'One isolated fictional game bullet impact, a tight dry snap and physical low thud, no voice.',
    ('combat', 'melee-impact'): 'One isolated fictional game rifle-butt impact, a heavy blunt thud with textured cloth and wood, no voice.',
}


def credential():
    key = os.environ.get('STABILITY_API_KEY')
    if key:
        return key
    path = Path.home() / 'zshrc'
    if path.exists():
        match = re.search(r'^export STABILITY_API_KEY=(.+)$', path.read_text(), re.M)
        if match:
            value = ast.literal_eval(match[1])
            if isinstance(value, str):
                return value
    raise SystemExit('STABILITY_API_KEY is not configured')


def request_api(path, key, data=None, content_type=None):
    headers = {'Authorization': 'Bearer ' + key, 'Accept': 'audio/*', 'User-Agent': 'Bolts-sound-review/1.0'}
    if content_type:
        headers['Content-Type'] = content_type
    request = urllib.request.Request(BASE + path, data=data, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        # No raw headers, full error response or credential in diagnostic output.
        raise RuntimeError(f'Stability returned HTTP {error.code}') from None
    except urllib.error.URLError:
        raise RuntimeError('Stability connection failed; no automatic resubmission') from None


def multipart(fields, audio):
    boundary = uuid.uuid4().hex
    chunks = []
    for name, value in fields.items():
        chunks.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    chunks.extend([f'--{boundary}\r\nContent-Disposition: form-data; name="audio"; filename="original.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode(), audio, f'\r\n--{boundary}--\r\n'.encode()])
    return b''.join(chunks), 'multipart/form-data; boundary=' + boundary


def jobs():
    result = []
    for source in json.loads((WORK / 'sources.json').read_text()):
        for index, (profile, label, description, strength) in enumerate(PROFILES):
            voice = source['group'] == 'voice'
            specific = (f'One original fictional adult male soldier speaking in {source["language"]}. '
                        f'Preserve the exact supplied words, once only: {source["text"]}. Strong low chest-resonant voice, forceful concise delivery. '
                        'Preserve the original speaker, language, pronunciation, timing and pitch. No singing, added words or repetitions.' if voice
                        else DESCRIPTIONS[(source['group'], source['sound'])])
            prompt = (specific + ' ' + description + ' Improve the supplied sound while preserving its essential identity and precise attack. '
                      'One dry close-recorded sound, followed by silence. No music, background scene, long reverb, loops or extra events.')
            result.append({**source, 'id': f'{source["group"]}-{source["sound"]}-{profile}', 'label': label,
                           'description': description, 'prompt': prompt, 'strength': [.10, .16, .22][index] if voice else strength,
                           'seed': 192531 + len(result) * 7919})
            result[-1].update(JOB_OVERRIDES.get(result[-1]['id'], {}))
    return result


def finish_candidate(raw, source, source_rate, group='rifle'):
    samples, rate = read_wav(raw)
    block = max(1, round(rate * .005))
    rms = np.sqrt(np.convolve(samples * samples, np.ones(block) / block, mode='same'))
    # Quiet syllables need a lower floor than impact detection. Speech is never
    # reduced to its loudest word when the utterance has deliberate pauses.
    threshold = max(float(rms.max()) * (.01 if group == 'voice' else .035), .0002 if group == 'voice' else .0004)
    active = np.flatnonzero(rms > threshold)
    if not len(active):
        raise ValueError('Generated candidate was silent')
    artifacts = []
    if group == 'voice':
        # Some provider takes have a tiny isolated click seconds after correct
        # speech. Only remove such boundary artifacts, never an interior word.
        parts = np.split(active, np.flatnonzero(np.diff(active) > rate) + 1)
        # Measure a click's active pulse at the original impact threshold while
        # retaining quieter speech with the lower trim floor above. Quiet parts
        # with no such pulse keep their full measured duration; low noise around
        # a clear pulse does not turn that pulse into a long spoken syllable.
        cores = []
        for part in parts:
            core = part[rms[part] > max(float(rms.max()) * .035, .0004)]
            cores.append(core if len(core) else part)
        part_energies = [float(np.sum(samples[int(part[0]):int(part[-1]) + 1] ** 2)) for part in parts]
        total_energy = float(np.sum(samples * samples))
        first, last = 0, len(parts) - 1

        def boundary_click(index):
            core = cores[index]
            return (int(core[-1]) - int(core[0]) + 1) / rate < .03 and part_energies[index] < total_energy * .001

        discarded = []
        while first < last and boundary_click(first):
            discarded.append(first)
            first += 1
        while last > first and boundary_click(last):
            discarded.append(last)
            last -= 1
        for index in sorted(discarded):
            part, core = parts[index], cores[index]
            artifacts.append({'reason': 'isolated-boundary-click', 'startSample': int(part[0]),
                              'endSampleExclusive': int(part[-1]) + 1, 'startSeconds': int(part[0]) / rate,
                              'endSeconds': (int(part[-1]) + 1) / rate,
                              'activeStartSample': int(core[0]), 'activeEndSampleExclusive': int(core[-1]) + 1,
                              'activeDurationSeconds': (int(core[-1]) - int(core[0]) + 1) / rate,
                              'energyFraction': part_energies[index] / total_energy})
        active = np.concatenate(parts[first:last + 1])
    duration = len(source) / source_rate
    # Short quiet gaps belong to one physical event (e.g. heel then toe). Long
    # gaps delimit separate generated effects, never material to squeeze into
    # one attack. Speech keeps the complete utterance, including word pauses.
    clusters = [active]
    if group != 'voice':
        gap = round(rate * max(.12, duration * .35))
        clusters = np.split(active, np.flatnonzero(np.diff(active) > gap) + 1)
    energies = [float(np.sum(samples[int(cluster[0]):int(cluster[-1]) + 1] ** 2)) for cluster in clusters]
    selected = int(np.argmax(energies))
    event = clusters[selected]
    start = max(0, int(event[0]) - round(rate * .012))
    end = min(len(samples), int(event[-1]) + 1 + round(rate * .035))
    sound = samples[start:end]
    target = max(1, round(duration * rate))
    scale = target / len(sound)
    minimum_scale = .65 if group == 'voice' else .6
    if scale < minimum_scale:
        raise ValueError('Candidate needs excessive time compression; raw take retained for review')
    # Match the already-shortened source, preserving the complete chosen event
    # or spoken utterance. Shorter takes get silence, not a stretched performance.
    if len(sound) >= target:
        output = compress_time(sound, rate, target / len(sound))
    else:
        output = np.pad(sound, (0, target - len(sound)))
    power = math.sqrt(float(np.mean(output * output)))
    source_power = math.sqrt(float(np.mean(source * source)))
    peak = float(np.max(np.abs(output)))
    if power < .00001 or peak < .0001:
        raise ValueError('Generated candidate has no usable level')
    gain = min(source_power / power, min(.88, float(np.max(np.abs(source)))) / peak)
    output *= gain
    return wav_bytes(output, rate), {'duration': len(output) / rate, 'generatedActiveDuration': len(sound) / rate,
                                     'timeScaleToSource': scale, 'appliedTimeScale': min(1., scale),
                                     'paddingSeconds': max(0, target - len(sound)) / rate, 'sourceDuration': duration,
                                     'extraction': {'method': 'whole-utterance' if group == 'voice' else 'dominant-event',
                                                    'startSample': start, 'endSampleExclusive': end,
                                                    'startSeconds': start / rate, 'endSeconds': end / rate,
                                                    'detectedEventCount': len(clusters), 'discardedEventCount': len(clusters) - 1,
                                                    'selectedEventIndex': selected,
                                                    'selectedEnergyFraction': energies[selected] / sum(energies),
                                                    'discardedArtifactCount': len(artifacts), 'discardedArtifacts': artifacts},
                                     'gain': gain, 'sampleRate': rate}


def run_job(job, key):
    PUBLIC.mkdir(parents=True, exist_ok=True)
    job_dir = WORK / 'jobs';job_dir.mkdir(exist_ok=True)
    record_path = job_dir / (job['id'] + '.json')
    record = json.loads(record_path.read_text()) if record_path.exists() else {}
    output = PUBLIC / (job['id'] + '.wav')
    source_blob = (ROOT / job['file']).read_bytes()
    source, rate = read_wav(source_blob)
    # The API requires >=6-second input. A quarter-second lead-in protects the
    # attack; silence fills the required container without duplicating events.
    padded = np.zeros(round(rate * 6.1));lead = round(rate * .25)
    padded[lead:lead + len(source)] = source
    fields = {'model': MODEL, 'prompt': job['prompt'], 'strength': job['strength'], 'seed': job['seed'],
              'steps': 8, 'duration': 6.1, 'output_format': 'wav'}
    if record and (record.get('request') != fields or record.get('sourceSha256') != hashlib.sha256(source_blob).hexdigest()):
        raise ValueError('Source/settings changed; archive the old job explicitly before regenerating')
    if record.get('complete') and record.get('processingVersion') == PROCESSING_VERSION and output.exists():
        return record['manifest']
    raw_path = job_dir / (job['id'] + '.raw.wav')
    if not raw_path.exists():
        if not record.get('generationId'):
            data, content_type = multipart(fields, wav_bytes(padded, rate))
            status, response = request_api('/v2beta/audio/stable-audio/audio-to-audio', key, data, content_type)
            if status != 202:
                raise RuntimeError(f'Unexpected generation status {status}')
            generation = json.loads(response)['id']
            record = {'id': job['id'], 'generationId': generation, 'request': fields, 'sourceSha256': hashlib.sha256(source_blob).hexdigest(),
                      'requestedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
            record_path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
        for attempt in range(60):
            if attempt:
                time.sleep(10)
            status, response = request_api('/v2beta/audio/results/' + record['generationId'], key)
            if status == 200:
                raw_path.write_bytes(response)
                break
            if status != 202:
                raise RuntimeError(f'Unexpected result status {status}')
        else:
            raise RuntimeError('Generation still pending; resume later without submitting again')
    final, metrics = finish_candidate(raw_path.read_bytes(), source, rate, job['group'])
    output.write_bytes(final)
    entry = {'id': job['id'], 'group': job['group'], 'sound': job['sound'], 'label': job['label'], 'description': job['description'],
             'file': '/assets/audio/candidates/' + output.name, 'provider': 'Stability AI', 'model': MODEL,
             'duration': metrics['duration'], 'seed': job['seed'], 'sourceInfluence': 1 - job['strength']}
    record.update({'complete': True, 'processingVersion': PROCESSING_VERSION, 'manifest': entry, 'processing': metrics, 'sha256': hashlib.sha256(final).hexdigest()})
    record_path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
    return entry


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--generate', action='store_true')
    parser.add_argument('--only', help='Comma-separated sound IDs for a pilot batch')
    parser.add_argument('--groups', help='Comma-separated groups to generate')
    parser.add_argument('--workers', type=int, default=2)
    args = parser.parse_args()
    plan = jobs()
    if args.groups:
        plan = [job for job in plan if job['group'] in args.groups.split(',')]
    if args.only:
        selected = set(args.only.split(','));plan = [job for job in plan if job['id'] in selected]
        if len(plan) != len(selected):
            raise SystemExit('Unknown --only sound ID')
    if not args.generate:
        print(json.dumps({'jobs': len(plan), 'maxCredits': len(plan) * 8, 'ids': [job['id'] for job in plan]}, indent=2))
        return
    key = credential()
    entries = {entry['id']: entry for entry in json.loads(MANIFEST.read_text())}
    # No retries or credit purchases. Completed/raw/pending jobs resume in place.
    errors = []
    with ThreadPoolExecutor(max_workers=max(1, min(args.workers, 3))) as pool:
        futures = {pool.submit(run_job, job, key): job for job in plan}
        for future in as_completed(futures):
            job = futures[future]
            try:
                entry = future.result();entries[entry['id']] = entry
                MANIFEST.write_text(json.dumps(sorted(entries.values(), key=lambda item: item['id']), ensure_ascii=False, indent=2) + '\n')
                print(f'Ready {entry["id"]}: {entry["duration"]:.3f}s', flush=True)
            except Exception as error:
                errors.append(job['id']);print(f'Failed {job["id"]}: {error}', flush=True)
    print(f'Review has {len(entries)} candidates; {len(errors)} failed jobs.', flush=True)
    if errors:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
