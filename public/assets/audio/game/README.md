# Recorded gameplay sounds

The game uses these 27 excerpts from the supplied `temp/game-audio/raw/` recordings: three reports per rifle, opening and closing bolt phases, reload handling phases, and two movement candidates. `shared/game-audio.json` is the runtime catalog. `provenance.json` records each source, original timestamps and hashes, processing settings, output hash, and measured levels.

Each file is a 48 kHz mono PCM16 WAV. Preparation averages the original stereo channels, applies a fixed −2.3 dB gain to all weapon recordings, and adds brief boundary fades to prevent clicks. Movement candidates share one gain that places their largest peak at −12 dBFS. This preserves relative levels within each group. No resampling, time compression, pitch change, denoising, or generated audio is involved. All original files remain unchanged.

Reports are 700 ms long: 10 ms pre-roll followed by 690 ms after the gunshot onset, preserving nearly twice the previous window. A 60 ms release fade smooths the ending. The clips stop before prominent bolt clicks; ambience and quieter handling can remain, and the latest decay overlaps the bolt. Bolt and reload excerpts retain ambience and overlapping handling. Reload loading bursts combine clip insertion, cartridge push, and removal. In particular, the Enfield bolt phases are approximate subdivisions of overlapping mechanical sounds.

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
