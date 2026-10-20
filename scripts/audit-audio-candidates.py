#!/usr/bin/env python3
"""Audit saved sound candidates without credentials, API calls, or generation.

Run with .tools/audio-analysis/bin/python. The default writes only
temp/stability-audio/audit.json. --write-provenance exports an allowlisted public
provenance file only after every expected candidate passes the audit.
"""
import argparse
from collections import Counter
import datetime
import hashlib
import io
import json
import math
from pathlib import Path
import re
import unicodedata
import wave

import numpy as np

from audio_processing import read_wav

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / 'temp/stability-audio'
PUBLIC = ROOT / 'public/assets/audio/candidates'
PROFILES = ('warm', 'crisp', 'gritty')
SAFE_NAME = re.compile(r'^[a-z0-9]+(?:-[a-z0-9]+)*$')
PROCESSING_NUMBERS = ('duration', 'generatedActiveDuration', 'timeScaleToSource', 'appliedTimeScale',
                      'paddingSeconds', 'sourceDuration', 'gain', 'sampleRate')
EXTRACTION_NUMBERS = ('startSample', 'endSampleExclusive', 'startSeconds', 'endSeconds',
                      'detectedEventCount', 'discardedEventCount', 'selectedEventIndex', 'selectedEnergyFraction', 'discardedArtifactCount')
ARTIFACT_NUMBERS = ('startSample', 'endSampleExclusive', 'startSeconds', 'endSeconds',
                    'activeStartSample', 'activeEndSampleExclusive', 'activeDurationSeconds', 'energyFraction')


def read_json(path):
    return json.loads(path.read_text())


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def normalized_words(text):
    return ''.join(character for character in unicodedata.normalize('NFKC', text).casefold() if character.isalnum())


def optional_transcript(candidate_id, digest):
    """Prefer hash-matched local ASR; never export its machine/model paths."""
    local = []
    for path in sorted((WORK / 'local-transcripts').glob(f'{candidate_id}*.json'), key=lambda path: path.stat().st_mtime, reverse=True):
        try:
            value = read_json(path)
            if value.get('id') == candidate_id:
                local.append(value)
        except (OSError, ValueError, TypeError):
            continue
    if local:
        return next((value for value in local if value.get('sha256') == digest), local[0]), 'local'
    path = WORK / 'transcripts' / f'{candidate_id}.transcript.json'
    return (read_json(path), 'provider') if path.exists() else (None, None)


def public_record(entry, record, profile):
    """Never copy whole job records: omit local paths, generation IDs and extras."""
    request, processing = record['request'], record['processing']
    extraction = processing['extraction']
    return {
        'id': entry['id'], 'group': entry['group'], 'sound': entry['sound'], 'profile': profile,
        'file': entry['file'], 'provider': 'Stability AI', 'sourceSha256': record['sourceSha256'],
        'sha256': record['sha256'], 'requestedAt': record.get('requestedAt'),
        'request': {key: request[key] for key in ('model', 'prompt', 'seed', 'strength', 'steps', 'duration', 'output_format')},
        'processingVersion': record['processingVersion'],
        'processing': {**{key: processing[key] for key in PROCESSING_NUMBERS},
                       'extraction': {'method': extraction['method'], **{key: extraction[key] for key in EXTRACTION_NUMBERS},
                                      'discardedArtifacts': [{'reason': artifact['reason'], **{key: artifact[key] for key in ARTIFACT_NUMBERS}}
                                                            for artifact in extraction['discardedArtifacts']]}},
    }


def audit_candidate(entry, source, profile):
    candidate_id = entry['id']
    result = {'id': candidate_id, 'group': entry.get('group'), 'sound': entry.get('sound'), 'profile': profile,
              'errors': [], 'warnings': []}
    errors = result['errors']
    expected_file = f'/assets/audio/candidates/{candidate_id}.wav'
    if entry.get('file') != expected_file:
        errors.append('Manifest asset URL does not match the candidate ID')
    try:
        blob = (PUBLIC / f'{candidate_id}.wav').read_bytes()
        with wave.open(io.BytesIO(blob), 'rb') as wav:
            channels, width, rate, frames = wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getnframes()
            pcm = wav.readframes(frames)
            if channels != 1 or width != 2 or wav.getcomptype() != 'NONE':
                raise ValueError('Finished WAV must be mono uncompressed PCM16')
            if rate <= 0 or frames <= 0 or len(pcm) != frames * 2:
                raise ValueError('Finished WAV has invalid or truncated audio frames')
        samples = np.frombuffer(pcm, dtype='<i2').astype(np.float64) / 32768
        peak, rms = float(np.max(np.abs(samples))), float(np.sqrt(np.mean(samples * samples)))
        digest = hashlib.sha256(blob).hexdigest()
        target_frames = source['frames'] * rate / source['rate']
        result.update({'sampleRate': rate, 'channels': channels, 'bitsPerSample': width * 8, 'frames': frames,
                       'duration': frames / rate, 'sourceDuration': source['frames'] / source['rate'],
                       'targetFrames': target_frames, 'durationErrorSamples': abs(frames - target_frames),
                       'finite': bool(np.isfinite(samples).all()), 'peak': peak, 'rms': rms, 'sha256': digest})
        if not result['finite']:
            errors.append('Finished samples are non-finite')
        if abs(frames - target_frames) > 1 + 1e-7:
            errors.append('Finished duration differs from the source by more than one output sample')
        if peak >= 32767 / 32768:
            errors.append('Finished PCM reaches a clipping rail')
        if rms < .00001 or peak < .0001:
            errors.append('Finished candidate has no usable audio level')
        if not finite(entry.get('duration')) or abs(entry['duration'] - frames / rate) > 1 / rate:
            errors.append('Manifest duration does not match the WAV')
        record = read_json(WORK / 'jobs' / f'{candidate_id}.json')
        if record.get('id') != candidate_id or record.get('complete') is not True:
            errors.append('Job record is incomplete or has a different ID')
        if record.get('sha256') != digest:
            errors.append('Finished SHA256 does not match the job record')
        if record.get('sourceSha256') != source['sha256']:
            errors.append('Source SHA256 does not match the current source bank')
        if not isinstance(record.get('processingVersion'), int) or record['processingVersion'] < 4:
            errors.append('Job needs current finishing metadata (processingVersion >= 4)')
        stored_manifest = record.get('manifest', {})
        for key in ('id', 'group', 'sound', 'file', 'model', 'seed', 'duration', 'sourceInfluence'):
            if stored_manifest.get(key) != entry.get(key):
                errors.append(f'Job and manifest disagree on {key}')
        request, processing = record.get('request', {}), record.get('processing', {})
        if request.get('model') != entry.get('model') or request.get('seed') != entry.get('seed'):
            errors.append('Requested model/seed does not match the manifest')
        if not isinstance(request.get('prompt'), str) or not request['prompt'].strip():
            errors.append('Job has no generation prompt')
        if not finite(request.get('strength')) or not 0 <= request['strength'] <= 1:
            errors.append('Job strength is invalid')
        elif not finite(entry.get('sourceInfluence')) or abs(entry['sourceInfluence'] - (1 - request['strength'])) > 1e-9:
            errors.append('Manifest source influence does not match request strength')
        for key in ('seed', 'steps'):
            if not isinstance(request.get(key), int) or isinstance(request[key], bool) or request[key] < (1 if key == 'steps' else 0):
                errors.append(f'Job {key} is invalid')
        if request.get('output_format') != 'wav' or not finite(request.get('duration')) or request['duration'] <= 0:
            errors.append('Job output format/duration is invalid')
        if any(not finite(processing.get(key)) for key in PROCESSING_NUMBERS):
            errors.append('Finishing metadata is missing or non-finite')
        else:
            for key, expected in (('duration', frames / rate), ('sourceDuration', source['frames'] / source['rate'])):
                if abs(processing[key] - expected) > 1 / rate:
                    errors.append(f'Finishing {key} does not match actual audio')
            if processing['sampleRate'] != rate or not 0 < processing['appliedTimeScale'] <= 1 or processing['paddingSeconds'] < 0:
                errors.append('Finishing sample rate, time scale or padding is invalid')
        extraction = processing.get('extraction', {})
        if extraction.get('method') not in ('dominant-event', 'whole-utterance') or any(not finite(extraction.get(key)) for key in EXTRACTION_NUMBERS):
            errors.append('Extraction bounds/event metadata is missing or non-finite')
        elif not 0 <= extraction['startSample'] < extraction['endSampleExclusive'] or extraction['discardedEventCount'] != extraction['detectedEventCount'] - 1:
            errors.append('Extraction bounds/event counts are inconsistent')
        artifacts = extraction.get('discardedArtifacts')
        if not isinstance(artifacts, list) or len(artifacts) != extraction.get('discardedArtifactCount'):
            errors.append('Discarded artifact metadata is missing or inconsistent')
        else:
            for artifact in artifacts:
                if not isinstance(artifact, dict) or artifact.get('reason') != 'isolated-boundary-click' or any(not finite(artifact.get(key)) for key in ARTIFACT_NUMBERS):
                    errors.append('Discarded artifact has invalid metadata')
                elif not (0 < artifact['activeDurationSeconds'] < .03 and 0 <= artifact['energyFraction'] < .001
                          and 0 <= artifact['startSample'] <= artifact['activeStartSample'] < artifact['activeEndSampleExclusive'] <= artifact['endSampleExclusive']):
                    errors.append('Discarded artifact exceeds the allowed click bounds')
        if entry.get('group') == 'voice':
            result['transcript'] = {'status': 'not-provided', 'required': False}
            try:
                transcript, origin = optional_transcript(candidate_id, digest)
            except (OSError, ValueError, TypeError):
                transcript, origin = None, None
                result['warnings'].append('Optional transcript could not be read')
            if transcript is not None:
                current = transcript.get('sha256') == digest
                text = transcript.get('transcript', transcript.get('text'))
                matches = isinstance(text, str) and normalized_words(text) == normalized_words(source.get('text', ''))
                result['transcript'] = {'status': 'current' if current else 'stale', 'origin': origin, 'required': False,
                                        'matchesExpectedWords': matches if current else None}
                if not current or not matches:
                    result['warnings'].append('Optional transcript is stale or differs from expected words; review the spoken audio')
        public = public_record(entry, record, profile) if not errors else None
    except (OSError, ValueError, KeyError, TypeError, wave.Error, EOFError) as error:
        # Avoid embedding arbitrary file paths or record contents in reports.
        errors.append(f'Unable to validate candidate assets/metadata ({type(error).__name__})')
        public = None
    result['ok'] = not errors
    return result, public


def run(write_provenance=False):
    errors, warnings, results, public = [], [], [], []
    source_rows = read_json(WORK / 'sources.json')
    manifest = read_json(ROOT / 'shared/audio-candidates.json')
    if not isinstance(source_rows, list) or not isinstance(manifest, list):
        raise ValueError('Sources and candidate manifest must be arrays')
    sources = {}
    for row in source_rows:
        group, sound = row.get('group'), row.get('sound')
        if not isinstance(group, str) or not isinstance(sound, str) or not SAFE_NAME.fullmatch(group) or not SAFE_NAME.fullmatch(sound):
            errors.append('Source has an invalid group/sound name')
            continue
        key = (group, sound)
        if key in sources:
            errors.append(f'Duplicate source {group}/{sound}')
            continue
        try:
            source_path = (ROOT / row['file']).resolve()
            if not source_path.is_relative_to(ROOT):
                raise ValueError('Source is outside the repository')
            blob = source_path.read_bytes()
            samples, rate = read_wav(blob)
            sources[key] = {**row, 'frames': len(samples), 'rate': rate, 'sha256': hashlib.sha256(blob).hexdigest()}
        except (OSError, ValueError, KeyError, TypeError):
            errors.append(f'Cannot validate source {group}/{sound}')
    expected = {f'{group}-{sound}-{profile}': (key, profile) for key in sources for group, sound in [key] for profile in PROFILES}
    ids = [entry.get('id') for entry in manifest if isinstance(entry, dict)]
    for candidate_id, count in Counter(value for value in ids if isinstance(value, str)).items():
        if count != 1:
            errors.append(f'Duplicate candidate ID {candidate_id}')
    coverage = []
    for (group, sound) in sources:
        present = [profile for profile in PROFILES if f'{group}-{sound}-{profile}' in ids]
        coverage.append({'group': group, 'sound': sound, 'profiles': present, 'complete': len(present) == 3})
        if len(present) != 3:
            errors.append(f'{group}/{sound} is missing profiles: {", ".join(profile for profile in PROFILES if profile not in present)}')
    for entry in manifest:
        if not isinstance(entry, dict) or not isinstance(entry.get('id'), str) or entry['id'] not in expected:
            errors.append('Manifest contains an unknown or malformed candidate')
            continue
        key, profile = expected[entry['id']]
        if (entry.get('group'), entry.get('sound')) != key:
            errors.append(f'Candidate {entry["id"]} has the wrong group/sound')
            continue
        result, sanitized = audit_candidate(entry, sources[key], profile)
        results.append(result)
        if sanitized is not None:
            public.append(sanitized)
    unlisted = sorted(path.name for path in PUBLIC.glob('*.wav') if path.stem not in ids)
    if unlisted:
        warnings.append(f'{len(unlisted)} saved WAV files are not listed in the current manifest')
    ok = not errors and len(results) == len(expected) and all(result['ok'] for result in results)
    report = {'version': 1, 'auditedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'ok': ok,
              'expectedSources': len(source_rows), 'expectedCandidates': len(source_rows) * 3, 'manifestCandidates': len(manifest),
              'passingCandidates': sum(result['ok'] for result in results), 'coverage': coverage,
              'errors': errors, 'warnings': warnings, 'candidates': results,
              'voiceTranscriptChecks': 'Optional text comparison only; listening review is still needed',
              'provenanceExport': 'not-requested' if not write_provenance else 'written' if ok else 'blocked-by-audit'}
    WORK.mkdir(parents=True, exist_ok=True)
    (WORK / 'audit.json').write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + '\n')
    if write_provenance and ok:
        provenance = {'version': 1, 'provider': 'Stability AI', 'method': 'source-conditioned audio-to-audio',
                      'endpoint': 'https://api.stability.ai/v2beta/audio/stable-audio/audio-to-audio',
                      'exportedAt': report['auditedAt'], 'candidates': sorted(public, key=lambda entry: entry['id'])}
        (PUBLIC / 'provenance.json').write_text(json.dumps(provenance, ensure_ascii=False, indent=2, allow_nan=False) + '\n')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write-provenance', action='store_true', help='Export sanitized public metadata only if the complete audit passes')
    args = parser.parse_args()
    report = run(args.write_provenance)
    failures = sum(not candidate['ok'] for candidate in report['candidates'])
    print(f'Audio audit: {report["passingCandidates"]}/{report["expectedCandidates"]} candidates pass; '
          f'{len(report["errors"])} coverage errors, {failures} candidate errors. Report: temp/stability-audio/audit.json')
    if args.write_provenance:
        print(f'Public provenance: {report["provenanceExport"]}')
    raise SystemExit(0 if report['ok'] else 1)


if __name__ == '__main__':
    main()
