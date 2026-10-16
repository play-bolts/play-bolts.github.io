#!/usr/bin/env python3
"""Rebuild selected CC0 surface textures with Khronos KTX-Software 4.4.2.

Requires Pillow for an objective, decoded-pixel quality check. The encoder is
an offline development tool; no new npm/runtime dependency or remote CDN.
Pass --toktx /path/to/toktx --ktx /path/to/ktx. Existing JPEGs remain fallbacks.
"""
import argparse
import hashlib
import json
import math
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageChops, ImageStat

ROOT = Path(__file__).resolve().parents[1]
MATERIALS = ROOT / 'public/assets/materials'
SELECTED = [(kind, role) for kind in ('stone', 'dirt', 'walnut') for role in ('basecolor', 'roughness')]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(args):
    subprocess.run([str(arg) for arg in args], check=True, capture_output=True, text=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--toktx', default='toktx')
    parser.add_argument('--ktx', default='ktx')
    args = parser.parse_args()
    version = subprocess.check_output([args.toktx, '--version'], text=True, stderr=subprocess.STDOUT).strip()
    if version != 'toktx v4.4.2':
        raise SystemExit('Use the pinned encoder to preserve reproducibility: toktx v4.4.2')
    options = ['--t2', '--encode', 'uastc', '--uastc_quality', '3', '--zcmp', '18',
               '--threads', '4', '--genmipmap', '--filter', 'box', '--lower_left_maps_to_s0t0']
    records = []
    with tempfile.TemporaryDirectory(prefix='bolts-ktx-') as temporary:
        for kind, role in SELECTED:
            source = MATERIALS / kind / f'{role}.jpg'
            output = source.with_suffix('.ktx2')
            transfer = 'srgb' if role == 'basecolor' else 'linear'
            # Three samples roughness from green. Explicit RGB swizzling avoids
            # an encoder representing grayscale JPEGs as red-only UASTC.
            channels = ['--target_type', 'RGB', '--input_swizzle', 'rrr1'] if role == 'roughness' else []
            run([args.toktx, *options, *channels, '--assign_oetf', transfer,
                 '--assign_primaries', 'bt709' if role == 'basecolor' else 'none', output, source])
            run([args.ktx, 'validate', '--warnings-as-errors', output])
            decoded = Path(temporary) / f'{kind}-{role}.png'
            run([args.ktx, 'extract', '--transcode', 'rgba8', output, decoded])
            original = Image.open(source).convert('RGB').transpose(Image.Transpose.FLIP_TOP_BOTTOM)
            reconstructed = Image.open(decoded).convert('RGB')
            difference = ImageChops.difference(original, reconstructed)
            mse = sum(value ** 2 for value in ImageStat.Stat(difference).rms) / 3
            psnr = 10 * math.log10(255 ** 2 / max(mse, 1e-20))
            if psnr < 40:
                raise SystemExit(f'{kind}/{role}: decoded PSNR {psnr:.2f} dB below 40 dB quality gate')
            width, height = original.size
            levels = int(math.log2(max(width, height))) + 1
            rgba_bytes = sum(max(1, width >> level) * max(1, height >> level) * 4 for level in range(levels))
            compressed_bytes = sum(math.ceil(max(1, width >> level) / 4) * math.ceil(max(1, height >> level) / 4) * 16 for level in range(levels))
            record = dict(path=str(output.relative_to(MATERIALS)), source=str(source.relative_to(MATERIALS)),
                          source_sha256=sha(source), sha256=sha(output), bytes=output.stat().st_size,
                          dimensions=[width, height], levels=levels, transfer=transfer,
                          orientation='ru', decoded_rgb_psnr_db=round(psnr, 3),
                          rgba8_gpu_bytes=rgba_bytes, astc4x4_or_bc7_gpu_bytes=compressed_bytes)
            records.append(record)
            print(f'{record["path"]}: {psnr:.2f} dB; {record["bytes"]:,} download bytes', flush=True)
    manifest = dict(encoder=version, license='CC0-1.0', original_provenance='provenance.json',
                    options=options, quality_note='UASTC quality 3, no lossy RDO, source resolution retained; normal/hand/weapon textures unchanged.',
                    maps=records, total_bytes=sum(item['bytes'] for item in records),
                    rgba8_gpu_bytes=sum(item['rgba8_gpu_bytes'] for item in records),
                    astc4x4_or_bc7_gpu_bytes=sum(item['astc4x4_or_bc7_gpu_bytes'] for item in records))
    (MATERIALS / 'compressed-provenance.json').write_text(json.dumps(manifest, indent=2) + '\n')


if __name__ == '__main__':
    main()
