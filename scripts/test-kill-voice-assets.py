#!/usr/bin/env python3
"""Check shipped voice PCM and finishing metadata without credentials or requests.

Run: .tools/audio-analysis/bin/python scripts/test-kill-voice-assets.py
"""
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import unittest
import wave

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('kill_voice_generator', Path(__file__).with_name('generate-kill-voices.py'))
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)


def levels(pcm):
    samples = np.frombuffer(pcm, dtype='<i2').astype(np.float64) / 32768
    return {
        'rmsDbfs': round(20 * math.log10(max(float(np.sqrt(np.mean(samples ** 2))), 1e-9)), 2),
        'peakDbfs': round(20 * math.log10(max(float(np.max(np.abs(samples))), 1e-9)), 2),
    }


class VoiceFinishingTests(unittest.TestCase):
    def test_generated_metrics_describe_compressed_pcm_and_preserve_pitch(self):
        rate = generator.RATE
        seconds = np.arange(rate) / rate
        # Unequal amplitude sections expose stale pre-compression RMS metadata.
        envelope = np.where(seconds < .23, .75, .12)
        raw = np.rint(np.sin(2 * np.pi * 220 * seconds) * envelope * 32767).astype('<i2').tobytes()
        pcm, metrics = generator.finish_pcm(raw)
        samples = np.frombuffer(pcm, dtype='<i2')
        self.assertEqual(len(samples), round(rate * .8))
        self.assertEqual(metrics['durationSeconds'], .8)
        self.assertEqual(metrics['processing'][0]['originalDurationSeconds'], 1)
        self.assertEqual(metrics['processing'][0]['timeScale'], .8)
        for key, value in levels(pcm).items():
            self.assertEqual(metrics[key], value)
        self.assertLessEqual(metrics['peakDbfs'], -6)
        middle = samples[2400:-2400].astype(np.float64)
        spectrum = np.abs(np.fft.rfft(middle * np.hanning(len(middle)), n=rate * 4))
        self.assertAlmostEqual(np.argmax(spectrum) / 4, 220, delta=.5)
        self.assertEqual(samples[0], 0)
        self.assertEqual(samples[-1], 0)

    def test_invalid_speech_is_rejected_before_asset_creation(self):
        for raw in (b'', bytes(generator.RATE * 2), bytes(generator.RATE * 2 * 13)):
            with self.subTest(bytes=len(raw)):
                with self.assertRaises(ValueError):
                    generator.finish_pcm(raw)


class ShippedVoiceTests(unittest.TestCase):
    def test_every_manifest_clip_has_final_metrics_hash_and_one_compression_pass(self):
        manifest = json.loads((ROOT / 'shared/kill-voices.json').read_text())
        records = json.loads((ROOT / 'public/assets/audio/voices/provenance.json').read_text())
        self.assertEqual({line['id'] for line in manifest}, {record['id'] for record in records})
        self.assertEqual(len(records), len(manifest))
        by_id = {line['id']: line for line in manifest}
        for record in records:
            with self.subTest(id=record['id']):
                line = by_id[record['id']]
                self.assertEqual(record['file'], line['file'])
                path = ROOT / 'public' / line['file'].lstrip('/')
                self.assertEqual(record['sha256'], hashlib.sha256(path.read_bytes()).hexdigest())
                with wave.open(str(path)) as wav:
                    self.assertEqual((wav.getnchannels(), wav.getsampwidth(), wav.getframerate()), (1, 2, 24000))
                    frames, rate = wav.getnframes(), wav.getframerate()
                    pcm = wav.readframes(frames)
                self.assertEqual(record['durationSeconds'], round(frames / rate, 6))
                for key, value in levels(pcm).items():
                    self.assertEqual(record[key], value)
                processing = record['processing']
                self.assertEqual(len(processing), 1)
                self.assertEqual(processing[0]['timeScale'], .8)
                self.assertEqual(processing[0]['method'], 'WSOLA pitch-preserving time compression')
                original_frames = round(processing[0]['originalDurationSeconds'] * rate)
                self.assertEqual(frames, round(original_frames * .8))
                samples = np.frombuffer(pcm, dtype='<i2')
                self.assertEqual(samples[0], 0)
                self.assertEqual(samples[-1], 0)
                self.assertLessEqual(record['peakDbfs'], -6)


if __name__ == '__main__':
    unittest.main(verbosity=2)
