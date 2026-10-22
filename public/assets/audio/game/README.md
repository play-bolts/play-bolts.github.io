# Recorded gameplay sounds

The game uses these 27 excerpts from the supplied `temp/game-audio/raw/` recordings: three reports per rifle, opening and closing bolt phases, reload handling phases, and two movement candidates. `shared/game-audio.json` is the runtime catalog. `provenance.json` records each source, original timestamps and hashes, processing settings, output hash, and measured levels.

Each file is a 48 kHz mono PCM16 WAV. Preparation averages the stereo channels, applies a fixed −2.3 dB gain to all weapon recordings, and fades the boundaries to prevent clicks. Movement candidates share one gain that places their largest peak at −12 dBFS. This preserves relative levels within each group. No resampling, time compression, pitch change, denoising, or generated audio is involved. The raw analysis WAVs remain unprocessed.

Reports are 1.0 second long: 10 ms pre-roll followed by 990 ms after the shot onset. The first 600 ms is preserved apart from a 2 ms attack fade; a 400 ms raised-cosine release eases the ending to silence with flat slopes at both ends. The listening package uses the same release on gunshot previews. The extended tail contains some early bolt handling, but not a complete bolt cycle. Bolt and reload excerpts retain ambience and overlapping handling. Reload loading bursts combine clip insertion, cartridge push, and removal.

The two movement excerpts are **unconfirmed footstep candidates**, shared across movement stances. Their source does not establish foot contact, foot side, gait, surface, or stance, and an off-screen sound cannot be excluded. The supplied set contains no established replacement for combat impacts, melee, weapon switching, UI sounds, or spoken lines.

Reproduce from the original local extraction package:

```sh
.tools/audio-analysis/bin/python scripts/prepare-game-audio.py
```

Verify the prepared files, catalog, and provenance byte for byte without modifying anything:

```sh
.tools/audio-analysis/bin/python scripts/prepare-game-audio.py --check
```

The script requires NumPy and `temp/game-audio/manifest.json` plus its selected raw WAVs. It verifies original hashes and validates mono format, sample count, non-clipped levels, non-silent content, and silent boundary samples. Original extraction instructions and annotations are in `scripts/extract-game-audio.py` and `scripts/game-audio-segments.json`.
