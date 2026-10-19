# Sound review, movement and character voices — 19 October 2026

The main-menu Sound review panel is available in production builds. Its isolated
preview player stops the previous source before selecting another and invalidates
pending fetch/decode work on Stop, close or navigation. It uses the saved volume.

The current rifle recipes and the Kar98k's 656 ms duration remain unchanged.
An optional **Fuller candidate** uses low/mid-band shaping and gentle saturation,
then matches the original RMS while keeping the original peak ceiling, sample
count and onset. This is DSP, not AI enhancement, and is review-only. RMS/peak,
transient timing and native-rate render checks guard the comparison.

Movement now has six original takes per foot and stance: 36 fixed buffers.
Walking layers heel/toe weight and grit; crouching emphasizes softer sole/cloth
texture; prone adds a sliding scrape. A deterministic shuffle alternates feet
without consecutive take repeats. Worker warmup and first-use fallback produce
identical samples. Review sequences use the same gain and gait contact cadence.

Nine original AI-generated soldier lines (three per language) are static WAVs;
see [asset provenance](../public/assets/audio/voices/README.md). Their runtime
bank loads during loadout selection, never on the kill-event path. Confirmed live
kills have a configurable 10% default chance, one global voice at a time, and a
500 ms gap after each clip. The local preference may produce different cosmetic
choices on different clients; it does not change network gameplay. Death,
life/faction changes, pause, replay, scene exit and roster/round changes cancel
voices. Historical reliable kill-feed events remain visible but cannot speak
through a newly spawned body. No speech-service credentials or runtime calls
ship in the client.

All final clips passed independent transcription checks after rejecting repeated
or unclear first takes; they are 1.42–2.53 seconds, 24 kHz mono, peak -6 dBFS.
Automated measurements verify technical behavior, not native-listener approval.
The review panel is the audition surface for final delivery and timbre preference.

# Kar98k timing revision — 17 October 2026

The Kar98k report is now 20% shorter: 656 ms instead of 820 ms. Its attack,
body, decay and reflection timings use a 0.8 scale. Resonant frequencies remain
unchanged, avoiding the pitch increase of faster sample playback. Enfield and
Mosin reports retain their original timing. Phase-spectrum checks use equivalent
compressed Kar98k windows and still meet the existing timbre bounds at 48 kHz;
44.1 kHz synthesis and worker/fallback parity also pass.

# Combat audio richness revision — 16 October 2026

The gunshot recipes now layer a short bipolar muzzle-pressure pulse, independent
high-frequency crack fragments, a falling low-body resonance with audible
harmonics, subtle mechanical attack, and seven increasingly dark early
reflections over the three existing rifle-specific reports. A gentle saturator
controls individual peaks before peak normalization; a 28 Hz high-pass removes
inaudible DC/rumble. The rifles retain their earlier characteristic phase spectra
and envelope relationships, but are denser at the same 0.88 PCM peak ceiling.
The numerical “new synthesis” table in the historical section below describes
the 14 October revision, not this revision.

Melee previously used a single 150 ms low-pass noise burst. It now has a rising
cloth/air swing (320 ms), separate from the confirmed hit. Bullet contact combines
a short bright snap, low thud and several small irregular texture grains (220 ms).
Melee contact has a heavier resonant body and darker snap (280 ms). A miss plays
only the swing. Confirmed contacts are routed at the victim/contact point, so they
have the same distance, cover and HRTF treatment as other world sounds.

## Technique and provenance

These are original procedural sound designs; no external recordings, sampled
game audio, spectral templates, or downloadable sound-pack assets are shipped.
The previous reference recordings remain local analysis material.

[Google's game-audio guide](https://web.dev/articles/webaudio-games) describes
using varied sample pools, spatial routing, and a final compressor to keep dense
game mixes controlled. The implementation follows those principles with three
fixed variants per sound, no immediately repeated waveform, and the existing
master compressor. [W3C Web Audio](https://www.w3.org/TR/webaudio-1.0/#AudioBufferSourceNode)
provides the reusable buffer/one-shot source model. All authored layers are baked
into one mono buffer per variant, preserving a single positional source instead
of accumulating live synthesizers or reverb graphs on every shot.

## Verification and audition

- 17 targeted audio tests pass: finite 44.1/48 kHz samples, peak limits, clean
  endpoints, low DC, distinct swing/contact envelopes, independent rifle timbres,
  worker transfer fidelity, contact ownership/position, variation/cache bounds,
  cover/panning, reload cancellation, scene cleanup and the 96-voice ceiling.
- TypeScript validation passes. The 18 PCM buffers use approximately 1.8 MiB at
  48 kHz, generated by the existing warmup worker. Warm playback allocates no new
  PCM buffers; a matching first-use fallback remains available without workers.
- `node --import tsx scripts/export-rifle-synthesis.ts artifacts/audio-richness/after`
  exports all nine rifle and nine swing/contact variants for headphone audition.
- `artifacts/audio-richness/audition.wav` contains Enfield before/after, Mosin
  before/after, Kar98k before/after, swing, bullet contact, then melee contact.
  `measurements.json` contains baseline/candidate peak and phase RMS levels.
- The development-only `audio-qa.html` now offers separate swing and impact
  audition buttons in addition to its browser-rendered spatial checks. Audio
  measurements establish technical behavior, not subjective listening approval.

---

# Rifle audio: multi-shot spectrogram revision — 14 October 2026

This revision supersedes the previous single-shot, whole-spectrum EQ comparison.
That approach left all three rifles sharing nearly the same noise texture and
decay. The current recipes change the spectrum **over time**, with separate
resonant-noise bands, transient/body/tail balances and decay shapes for each rifle.
Only original synthesized noise/resonances are shipped; reference recordings
remain ignored local analysis material.

## Sources and clean windows

PC Gaming Videos' [CoD1/UO firing showcase](https://www.youtube.com/watch?v=sK4UBZtE6o0)
provides three selected firing instances per rifle:

| Rifle | Shot onsets, seconds | Shot/background RMS contrast |
| --- | --- | --- |
| Lee–Enfield | 327.316, 329.043, 332.385 | 18.1–25.4 dB |
| Mosin–Nagant | 235.265, 237.066, 242.049 | 35.9–37.5 dB |
| Kar98k | 252.441, 253.870, 258.229 | 31.0–43.3 dB |

Each onset was checked against labeled rifle footage, muzzle flash and recoil.
The second Mosin flash fell between the initial contact-sheet samples; a 60 fps
extraction confirmed it at approximately 237.067–237.083 s. The showcase hides
ammunition, so identity was not inferred from an ammo change. Root independently
reviewed the three contact sheets. No browser was used for reference acquisition
or review: local media extraction and frame inspection were sufficient.

The supplied [multiplayer recording](https://www.youtube.com/watch?v=-0FQ5HX209g&t=137s)
remains a Mosin sanity check: the 137.380 s firing onset gives about 967 Hz over the
previous 160 ms FFT window. Its round-ending activity makes the late tail unsuitable
for fitting. The [reload-only showcase](https://www.youtube.com/watch?v=OUmvpEm7FII)
was excluded from shot analysis; its loud handling peaks must not be called shots.

All comparisons use the first **350 ms** after onset, divided into attack
0–25 ms, body 25–140 ms, and early tail 140–350 ms. This avoids the obvious later
bolt/reload bursts; residual ambience or mechanical overlap cannot be ruled out.
Shot/background contrast compares RMS in that 350 ms interval with −100 to −30 ms
before onset. It is an observed level ratio, not a noise-free source measurement.

## Method and findings

Audio is decoded to mono 48 kHz PCM16. Spectrograms use a 1024-sample Hann STFT
(21.3 ms window, 2.67 ms hop); each panel shows the median of three normalized
instances. Phase measurements use Hann FFTs restricted to 60 Hz–12 kHz. Frequency
shape error is mean absolute difference in 24 logarithmic band-energy levels
across all three phases. Envelope error compares normalized 5 ms RMS curves.
Old and new synthesis each use three deterministic random variants. Comparisons
are relative to the mean of three reference shots, not an isolated game asset.

| Rifle | Reference attack/body/tail centroid, Hz | New synthesis, Hz | Spectral error, old → new | Envelope error, old → new |
| --- | --- | --- | --- | --- |
| Enfield | 2233 / 945 / 819 | 2256 / 973 / 826 | 2.77 → 2.38 dB | 2.41 → 2.35 dB |
| Mosin | 2210 / 857 / 617 | 2348 / 867 / 635 | 3.25 → 1.94 dB | 2.90 → 1.80 dB |
| Kar98k | 3000 / 1667 / 1535 | 3073 / 1636 / 1718 | 2.78 → 2.22 dB | 6.44 → 1.18 dB |

The new differences are structural, not just louder or differently equalized:

- **Enfield:** a stronger opening crack, broad warm body around 300–550 Hz, then
  a quicker fall into the low thump. Tail/body level is −6.48 dB, reference −6.54.
- **Mosin:** a crisp opening followed by a darker, more resonant low tail, with
  emphasis around 186–245 Hz. Tail/body is −2.77 dB, reference −2.96.
- **Kar98k:** the brightest crack, more persistent 1–3 kHz rasp, and a body that
  remains strong through roughly 330 ms. Tail/body is −0.48 dB, reference −0.72.

Mosin remains between Enfield and Kar in the synthesized opening transient, but
its body/tail is **darker than Enfield**, as consistently measured in the footage.
The previous requirement that its entire-shot centroid always sit in the middle
was an authored assumption, not a reference fact, and is superseded.

Pairwise time-frequency separation also moved toward the observed distinctions:

| Pair | Reference | Old synthesis | New synthesis |
| --- | ---: | ---: | ---: |
| Enfield / Mosin | 2.37 dB | 0.98 dB | 1.76 dB |
| Enfield / Kar | 3.31 dB | 2.45 dB | 3.04 dB |
| Mosin / Kar | 4.21 dB | 1.51 dB | 3.66 dB |

These are acoustic-feature distances, **not perceptual listening scores**. The
expected audible changes are a shorter Enfield thump, deeper Mosin decay and a
longer raspy Kar report. Roughness is not perfectly matched: the relative 5 ms
envelope-fluctuation descriptor is reference/new 0.141/0.189 for Enfield,
0.180/0.213 for Mosin, and 0.127/0.131 for Kar. Codec, mix, gain, ambience and the
small sample set limit precision. No claim of exact original-sample reproduction
or subjective listening approval is made.

## Reproduction and runtime validation

Run `node --import tsx scripts/export-rifle-synthesis.ts`, then
`python scripts/compare-rifle-spectrograms.py` with numpy/matplotlib. The script
expects ignored reference WAVs and the previous synthesis under
`artifacts/audio-reference/before-spectrogram/` (baseline source revision
`f876f48671551f784a684af80c396a2069525511`). Outputs include
`rifle-spectrograms.png` / `.svg`, `rifle-phase-comparison.png`, and
`spectrogram-measurements.json`; plots were visually inspected. No recordings,
reference waveforms or dense source spectra are embedded in runtime code.

The [W3C Web Audio](https://www.w3.org/TR/webaudio/#PannerNode) spatial path is
unchanged: every shot's bands share one HRTF source, with actor positions, camera
orientation, distance/cover filtering and first-person bypass. Actor-specific
reload cancellation, ended-node disposal, and the 96-voice cap remain covered.
Nine focused tests now check all three variants, reference-derived phase spectra,
distinct envelope ratios, finite 44.1/48 kHz PCM, and the existing spatial/lifecycle
behavior. TypeScript validation passed.

The development-only `audio-qa.html` includes Current / Before / Local reference
buttons and actual browser `OfflineAudioContext` checks. Root's final candidate
passed all six spatial checks: right +3.32 dB balance, left −3.36 dB, 180° turn
−3.47 dB, near −14.61 versus far −25.61 dB, followed actor 0 dB balance, and covered
−26.20 versus clear −19.64 dB. Those are rendered browser measurements, separate
from mocked graph tests. The reference buttons depend on ignored local media;
neither that page nor those recordings is included in the production build.
