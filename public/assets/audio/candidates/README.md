# Sound review candidates

These are three source-conditioned alternatives per sound: **Warm & full**, **Crisp & detailed**, and **Gritty & powerful**. They cover the three rifles, three movement stances, three combat effects, and nine original spoken lines. The current source remains available alongside the alternatives on the standalone sound review page; generation does not automatically replace it.

The source effects are original project synthesis. The voice sources use original project scripts rendered with OpenAI TTS; their source provenance is in `../voices/provenance.json`. No third-party sound library recordings are used as these inputs.

Candidates are generated ahead of time through Stability AI's `stable-audio-3` audio-to-audio API. Each request uses the actual source WAV, a descriptive prompt, a fixed seed, and a recorded transformation strength. Short inputs are padded with silence to satisfy the API input duration; the sound is not repeated. This is source-conditioned resynthesis, not a claim that increasing sample rate improves realism. See the [official audio-to-audio guidance](https://kb.stability.ai/knowledge-base/stable-audio-3-prompt-guide).

Finishing selects the strongest isolated event for effects while preserving its attack and tail margins. Speech retains the complete utterance, including quiet words and pauses. A tiny boundary click may be removed only when separated by more than one second of silence, active for less than 30 ms, and carrying less than 0.1% of the take's energy; those removals are recorded separately. Moderate pitch-preserving WSOLA compression fits longer accepted takes to the already-shortened source duration; shorter takes receive silence padding. Takes requiring excessive compression are rejected. Every finished file is a mono PCM16 WAV. Listen to candidates before selecting them, especially for speech wording and pronunciation.

The browser plays saved assets and never calls an audio-generation API. Credentials and local job records are not distributed. `provenance.json`, when exported after validation, contains only allowlisted generation and finishing details: source/output hashes, model, prompt, seed, strength, steps, extraction bounds, discarded click details, time compression, and padding. It excludes credentials, private file paths, and generation job identifiers.

To reproduce the source bank and inspect the generation plan from the repository root:

```sh
node --import tsx scripts/export-sound-review.ts
.tools/audio-analysis/bin/python scripts/generate-stability-audio.py
```

The first command exports the current source sounds; the second only prints a plan. Explicitly making paid generation requests requires:

```sh
.tools/audio-analysis/bin/python scripts/generate-stability-audio.py --generate
```

The baseline is 54 candidates at 8 credits each, or 432 credits. This bank used 56 provider results including two rejected effects, totaling 448 credits; the balance verified after those requests was 52 credits. Saved completed, pending, and raw jobs are reused, and changed source/settings signatures require explicit archiving before regeneration. These commands do not buy credits automatically.

From the repository root, audit without generating or downloading anything:

```sh
.tools/audio-analysis/bin/python scripts/audit-audio-candidates.py
```

The report is written to `temp/stability-audio/audit.json`. It verifies three profiles per source, source/output hashes, job metadata, mono PCM16 format, duration within one output sample, finite samples, and non-clipped levels. Existing local transcripts are preferred over earlier provider transcripts and checked optionally against the exact asset hash; automated text matches do not establish delivery quality.

After every expected candidate passes, export public provenance:

```sh
.tools/audio-analysis/bin/python scripts/audit-audio-candidates.py --write-provenance
```

An incomplete or failing audit exits with a nonzero status and does not overwrite public provenance.

Local speech checks use `scripts/transcribe-stability-local.py` with the downloaded MLX Whisper large-v3-turbo model; no generated clips are uploaded for this check. Several Stability voice transformations produce word or pronunciation ambiguities. The review page shows notes from `shared/audio-candidate-reviews.json`; these are audition flags, not claims that automated transcription is infallible. The current voices remain the game defaults.
