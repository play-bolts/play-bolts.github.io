#!/usr/bin/env python3
"""Offline numerical checks; no credentials, network requests, or model downloads.

Run: .tools/audio-analysis/bin/python scripts/test-audio-processing.py
These checks establish duration/pitch/basic integrity, not perceived sound quality.
"""
import importlib.util
from pathlib import Path
import struct
import unittest

import numpy as np

from audio_processing import compress_pcm16, compress_time, cosine_release, read_wav, wav_bytes

generator_spec = importlib.util.spec_from_file_location('stability_audio', Path(__file__).with_name('generate-stability-audio.py'))
generator = importlib.util.module_from_spec(generator_spec)
generator_spec.loader.exec_module(generator)


def tone(rate, frequency, seconds=1, amplitude=.5):
    return amplitude * np.sin(2 * np.pi * frequency * np.arange(round(rate * seconds)) / rate)


def dominant_frequency(samples, rate):
    # Ignore short fades and overlap boundaries at either end. Four-second FFT
    # padding makes the bin spacing .25 Hz without depending on SciPy/librosa.
    middle = samples[round(rate * .1):-round(rate * .1)]
    spectrum = np.abs(np.fft.rfft(middle * np.hanning(len(middle)), n=rate * 4))
    return np.argmax(spectrum) / 4


def provider_wav(samples, rate, channels=1, encoding=3, bits=32):
    width = bits // 8
    fmt = struct.pack('<HHIIHH', encoding, channels, rate, rate * channels * width, channels * width, bits)
    body = b'fmt ' + struct.pack('<I', len(fmt)) + fmt + b'data' + struct.pack('<I', len(samples)) + samples
    if len(samples) % 2:
        body += b'\0'
    return b'RIFF' + struct.pack('<I', len(body) + 4) + b'WAVE' + body


class ReleaseTests(unittest.TestCase):
    def test_release_preserves_body_stereo_balance_and_timing(self):
        rate = 48000
        source = np.tile([.6, -.3], (round(rate * .8), 1))
        release_start = round(rate * .5)
        result = cosine_release(source, rate, .3)
        self.assertEqual(result.shape, source.shape)
        np.testing.assert_array_equal(result[:release_start], source[:release_start])
        np.testing.assert_array_equal(source, np.tile([.6, -.3], (len(source), 1)))
        np.testing.assert_allclose(result[:, 0], -2 * result[:, 1])
        self.assertTrue(np.all(np.diff(result[release_start:, 0]) <= 0))
        self.assertGreater(result[release_start + 3600, 0], .45, 'first quarter of release remains audible')
        self.assertTrue(np.all(result[-1] == 0))
        self.assertLess(abs(result[-2, 0]), 1e-7, 'no steep final envelope step')
        self.assertLess(abs(result[release_start + 1, 0] - result[release_start, 0]), 1e-7)
        np.testing.assert_allclose(cosine_release(source[:, 0], rate, .3), result[:, 0])


class TimeCompressionTests(unittest.TestCase):
    def test_twenty_percent_compression_has_exact_length_at_game_and_voice_rates(self):
        for rate in (24000, 44100, 48000):
            with self.subTest(rate=rate):
                source = tone(rate, 220, .913)
                original = source.copy()
                result = compress_time(source, rate, .8)
                self.assertEqual(len(result), round(len(source) * .8))
                self.assertTrue(np.isfinite(result).all())
                self.assertLessEqual(float(np.max(np.abs(result))), float(np.max(np.abs(source))) + 1e-10)
                np.testing.assert_array_equal(source, original)

    def test_twenty_percent_compression_preserves_pitch_instead_of_speeding_playback(self):
        rate = 24000
        for frequency in (110, 220, 440, 1000, 3000):
            with self.subTest(frequency=frequency):
                result = compress_time(tone(rate, frequency), rate, .8)
                self.assertAlmostEqual(dominant_frequency(result, rate), frequency, delta=.5)
                # Faster sample playback would put this peak at frequency / .8.
                middle = result[2400:-2400]
                self.assertGreater(float(np.sqrt(np.mean(middle ** 2))), .25)

    def test_identity_factor_preserves_every_sample(self):
        source = np.random.default_rng(71).uniform(-.8, .8, 12345)
        result = compress_time(source, 24000, 1)
        np.testing.assert_array_equal(result, source)
        self.assertFalse(np.shares_memory(source, result))

    def test_silence_remains_silent_and_finite(self):
        result = compress_time(np.zeros(24000), 24000, .8)
        self.assertEqual(len(result), 19200)
        np.testing.assert_array_equal(result, np.zeros(19200))

    def test_early_middle_and_final_short_bursts_survive(self):
        rate = 24000
        source = np.zeros(rate)
        duration = round(rate * .01)
        for onset, frequency in ((.1, 300), (.45, 700), (.9, 1200)):
            burst = tone(rate, frequency, .01, 1) * np.sin(np.pi * np.arange(duration) / duration)
            first = round(onset * rate)
            source[first:first + duration] = burst
        result = compress_time(source, rate, .8)
        for onset in (.1, .45, .9):
            with self.subTest(onset=onset):
                first = max(0, round((onset * .8 - .05) * rate))
                last = min(len(result), round((onset * .8 + .07) * rate))
                self.assertGreater(float(np.sum(result[first:last] ** 2)), 1)
        self.assertEqual(result[0], 0)
        self.assertEqual(result[-1], 0)

    def test_pcm16_wrapper_keeps_mono_frames_and_pitch_without_clipping(self):
        rate = 24000
        pcm = np.rint(tone(rate, 220) * 32767).astype('<i2')
        result = np.frombuffer(compress_pcm16(pcm.tobytes(), rate, .8), dtype='<i2')
        self.assertEqual(len(result), round(len(pcm) * .8))
        self.assertAlmostEqual(dominant_frequency(result.astype(np.float64), rate), 220, delta=.5)
        self.assertLessEqual(int(np.max(np.abs(result.astype(np.int32)))), int(np.max(np.abs(pcm.astype(np.int32)))))


class ProviderWavTests(unittest.TestCase):
    def test_pcm16_round_trip_preserves_rate_duration_and_signal(self):
        source = tone(48000, 330, .2)
        result, rate = read_wav(wav_bytes(source, 48000))
        self.assertEqual(rate, 48000)
        self.assertEqual(len(result), len(source))
        np.testing.assert_allclose(result, source, atol=2 / 32768)

    def test_stereo_float_provider_audio_is_averaged_correctly(self):
        source = np.array([[.5, .25], [-.4, -.2], [0, .1]], dtype='<f4')
        result, rate = read_wav(provider_wav(source.tobytes(), 48000, channels=2))
        self.assertEqual(rate, 48000)
        np.testing.assert_allclose(result, source.astype(np.float64).mean(axis=1), atol=1e-8)

    def test_signed_24_bit_provider_samples_decode(self):
        integers = [-8388608, -1, 0, 1, 8388607]
        raw = b''.join((value & 0xffffff).to_bytes(3, 'little') for value in integers)
        result, rate = read_wav(provider_wav(raw, 44100, encoding=1, bits=24))
        self.assertEqual(rate, 44100)
        np.testing.assert_array_equal(result, np.array(integers) / 8388608)

    def test_empty_nonfinite_and_nonwav_provider_outputs_are_rejected(self):
        for raw in (b'not audio', provider_wav(b'', 48000), provider_wav(np.array([np.nan], dtype='<f4').tobytes(), 48000)):
            with self.subTest(length=len(raw)):
                with self.assertRaises(ValueError):
                    read_wav(raw)


class CandidateExtractionTests(unittest.TestCase):
    rate = 24000

    def raw(self, events):
        samples = np.zeros(round(self.rate * 6.1))
        for onset, duration, amplitude in events:
            event = tone(self.rate, 660, duration, amplitude)
            first = round(onset * self.rate)
            samples[first:first + len(event)] += event
        return wav_bytes(samples, self.rate)

    def finish(self, events, duration=.3, group='combat'):
        return generator.finish_candidate(self.raw(events), tone(self.rate, 330, duration), self.rate, group)

    def test_strongest_energy_event_is_selected_even_if_another_has_higher_peak(self):
        # A brief loud blip precedes the desired lower-peak, much higher-energy
        # event. The five-second gap must never be compressed into one effect.
        blob, metrics = self.finish([(.25, .005, .8), (5.4, .12, .35)])
        extraction = metrics['extraction']
        self.assertEqual(extraction['detectedEventCount'], 2)
        self.assertEqual(extraction['discardedEventCount'], 1)
        self.assertEqual(extraction['selectedEventIndex'], 1)
        self.assertGreater(extraction['selectedEnergyFraction'], .75)
        self.assertLess(extraction['startSeconds'], 5.4)
        self.assertGreater(extraction['startSeconds'], 5.37)
        self.assertGreater(extraction['endSeconds'], 5.52)
        self.assertLess(extraction['endSeconds'], 5.57)
        result, rate = read_wav(blob)
        self.assertEqual(len(result), round(.3 * rate))
        self.assertEqual(metrics['appliedTimeScale'], 1)
        self.assertGreater(metrics['timeScaleToSource'], 1)
        self.assertGreater(metrics['paddingSeconds'], .1)
        self.assertAlmostEqual(metrics['generatedActiveDuration'] + metrics['paddingSeconds'], metrics['duration'])
        self.assertTrue(np.isfinite(result).all())

    def test_short_internal_gap_preserves_both_parts_of_one_event(self):
        _, metrics = self.finish([(.25, .04, .4), (.35, .04, .4)])
        extraction = metrics['extraction']
        self.assertEqual(extraction['detectedEventCount'], 1)
        self.assertEqual(extraction['discardedEventCount'], 0)
        self.assertLess(extraction['startSeconds'], .25)
        self.assertGreater(extraction['endSeconds'], .39)

    def test_voice_preserves_words_on_both_sides_of_a_long_pause(self):
        _, metrics = self.finish([(.25, .15, .4), (.8, .15, .4)], duration=1., group='voice')
        extraction = metrics['extraction']
        self.assertEqual(extraction['method'], 'whole-utterance')
        self.assertEqual(extraction['discardedEventCount'], 0)
        self.assertLess(extraction['startSeconds'], .25)
        self.assertGreater(extraction['endSeconds'], .95)
        with self.assertRaisesRegex(ValueError, 'excessive time compression'):
            self.finish([(.25, .15, .4), (.8, .15, .4)], duration=.3, group='voice')

    def test_voice_removes_only_tiny_isolated_boundary_clicks(self):
        for events, expected_start, expected_end in (
            ([(.25, .4, .5), (5.75, .004, .02)], .25, .65),
            ([(.01, .004, .02), (1.4, .4, .5)], 1.4, 1.8),
        ):
            with self.subTest(events=events):
                _, metrics = self.finish(events, duration=.7, group='voice')
                extraction = metrics['extraction']
                self.assertEqual(extraction['method'], 'whole-utterance')
                self.assertEqual(extraction['discardedEventCount'], 0)
                self.assertEqual(extraction['discardedArtifactCount'], 1)
                artifact = extraction['discardedArtifacts'][0]
                self.assertLess(artifact['activeDurationSeconds'], .03)
                self.assertLess(artifact['energyFraction'], .001)
                self.assertLess(extraction['startSeconds'], expected_start)
                self.assertGreater(extraction['startSeconds'], expected_start - .03)
                self.assertGreater(extraction['endSeconds'], expected_end)
                self.assertLess(extraction['endSeconds'], expected_end + .05)

    def test_very_quiet_first_or_last_word_and_long_pause_remain(self):
        for events, expected_end in (
            ([(.25, .08, .01), (1.6, .4, .5)], 2.),
            ([(.25, .4, .5), (2., .08, .01)], 2.08),
        ):
            with self.subTest(events=events):
                _, metrics = self.finish(events, duration=2.1, group='voice')
                extraction = metrics['extraction']
                self.assertEqual(extraction['discardedArtifactCount'], 0)
                self.assertLess(extraction['startSeconds'], .25)
                self.assertGreater(extraction['endSeconds'], expected_end)
                self.assertGreater(metrics['generatedActiveDuration'], 1.75)

    def test_boundary_sound_without_click_duration_energy_or_gap_criteria_is_not_removed(self):
        for tail in ((5.75, .01, .8), (5.75, .06, .02), (1.4, .004, .02)):
            with self.subTest(tail=tail):
                with self.assertRaisesRegex(ValueError, 'excessive time compression'):
                    self.finish([(.25, .4, .5), tail], duration=.7, group='voice')

    def test_quiet_interior_click_is_not_used_to_cut_an_utterance(self):
        _, metrics = self.finish([(.25, .08, .01), (1.6, .004, .02), (3., .4, .5)], duration=3.3, group='voice')
        extraction = metrics['extraction']
        self.assertEqual(extraction['discardedArtifactCount'], 0)
        self.assertLess(extraction['startSeconds'], .25)
        self.assertGreater(extraction['endSeconds'], 3.4)

    def test_moderate_sfx_compression_below_old_threshold_is_allowed(self):
        blob, metrics = self.finish([(.25, .47, .4)], duration=.32, group='movement')
        self.assertGreaterEqual(metrics['appliedTimeScale'], .6)
        self.assertLess(metrics['appliedTimeScale'], .65)
        self.assertEqual(metrics['paddingSeconds'], 0)
        result, rate = read_wav(blob)
        self.assertEqual(len(result), round(.32 * rate))
        self.assertAlmostEqual(dominant_frequency(result, rate), 660, delta=1)

    def test_continuous_long_effect_is_rejected_instead_of_truncated_or_mangled(self):
        for duration, target in ((.514, .24), (.49, .224), (.349, .176)):
            with self.subTest(duration=duration, target=target):
                with self.assertRaisesRegex(ValueError, 'excessive time compression'):
                    self.finish([(.25, duration, .4)], duration=target)

    def test_silent_generation_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'silent'):
            self.finish([])


if __name__ == '__main__':
    unittest.main(verbosity=2)
