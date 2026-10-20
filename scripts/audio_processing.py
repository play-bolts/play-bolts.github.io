"""Offline audio finishing shared by the asset scripts (requires NumPy).

WSOLA compresses time by overlapping waveform-aligned windows. Oscillation
periods stay unchanged; this is not faster, higher-pitched sample playback.
"""
import numpy as np
import io
import struct
import wave


def compress_time(samples, rate, factor=.8):
    data = np.asarray(samples, dtype=np.float64)
    target = max(1, round(len(data) * factor))
    if factor == 1 or len(data) < 256:
        return data.copy() if factor == 1 else data[:target].copy()
    window = min(round(rate * .04), len(data))
    hop = max(1, round(rate * .01))
    overlap = window - hop
    search = round(rate * .012)
    output = np.zeros(target + window)
    weights = np.zeros_like(output)
    taper = np.hanning(window)
    previous = 0
    for position in range(0, target, hop):
        expected = round(position / factor)
        start = min(max(0, expected), len(data) - window)
        if position and position + overlap <= len(output):
            # Align the next grain to the already synthesized overlap; bounded
            # search prevents an accumulating drift from the requested duration.
            low = max(previous + 1, expected - search, 0)
            high = min(expected + search, len(data) - window)
            if low <= high:
                reference = output[position:position + overlap] / np.maximum(weights[position:position + overlap], 1e-8)
                section = data[low:high + overlap]
                correlation = np.correlate(section, reference, mode="valid")
                power_sum = np.concatenate(([0.], np.cumsum(section * section)))
                power = power_sum[overlap:] - power_sum[:-overlap]
                score = correlation / np.sqrt(np.maximum(power, 1e-12))
                # Prefer the requested analysis position when several alignments
                # are equivalent (e.g. silence), rather than elongating pauses.
                score -= np.max(np.abs(score), initial=0) * .003 * np.abs(np.arange(low, high + 1) - expected) / max(search, 1)
                start = low + int(np.argmax(score))
        grain = data[start:start + window]
        output[position:position + window] += grain * taper
        weights[position:position + window] += taper
        previous = start
    output = (output / np.maximum(weights, 1e-8))[:target]
    fade = min(round(rate * .005), target // 2)
    if fade:
        output[:fade] *= np.linspace(0, 1, fade)
        output[-fade:] *= np.linspace(1, 0, fade)
    peak = np.max(np.abs(output), initial=0)
    if peak:
        output *= np.max(np.abs(data), initial=0) / peak
    return output


def compress_pcm16(pcm, rate, factor=.8):
    source = np.frombuffer(pcm, dtype="<i2").astype(np.float64)
    output = compress_time(source, rate, factor)
    return np.clip(np.rint(output), -32768, 32767).astype("<i2").tobytes()


def read_wav(blob):
    """Read PCM/float provider WAVs, averaging channels for positional one-shots."""
    if blob[:4] != b"RIFF" or blob[8:12] != b"WAVE":
        raise ValueError("Provider returned an invalid WAV")
    offset, fmt, raw = 12, None, None
    while offset + 8 <= len(blob):
        tag, size = blob[offset:offset + 4], struct.unpack_from("<I", blob, offset + 4)[0]
        chunk = blob[offset + 8:offset + 8 + size]
        if tag == b"fmt ":
            fmt = chunk
        if tag == b"data":
            raw = chunk
        offset += 8 + size + size % 2
    if fmt is None or raw is None:
        raise ValueError("WAV has no format or audio data")
    encoding, channels, rate, _, _, bits = struct.unpack_from("<HHIIHH", fmt)
    if encoding == 65534:
        encoding = struct.unpack_from("<H", fmt, 24)[0]
    if encoding == 3 and bits == 32:
        samples = np.frombuffer(raw, dtype="<f4").astype(np.float64)
    elif encoding == 1 and bits in (16, 32):
        samples = np.frombuffer(raw, dtype=f"<i{bits // 8}").astype(np.float64) / (2 ** (bits - 1))
    elif encoding == 1 and bits == 24:
        values = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        integers = values[:, 0] | values[:, 1] << 8 | values[:, 2] << 16
        samples = ((integers ^ 0x800000) - 0x800000) / 8388608.
    else:
        raise ValueError(f"Unsupported WAV encoding {encoding}/{bits}")
    samples = samples.reshape(-1, channels).mean(axis=1)
    if not np.isfinite(samples).all() or not len(samples):
        raise ValueError("WAV is empty or non-finite")
    return samples, rate


def wav_bytes(samples, rate):
    data = io.BytesIO()
    with wave.open(data, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(rate)
        output.writeframes(np.clip(np.rint(np.asarray(samples) * 32767), -32768, 32767).astype("<i2").tobytes())
    return data.getvalue()
