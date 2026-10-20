# Original character voice clips

These nine mono WAV clips are AI-generated performances of original fictional
British, German and Russian soldier lines. No recording or imitation of a named
person was used. The app discloses their AI origin in Sound review and Credits.

Generated with OpenAI `gpt-4o-mini-tts-2025-12-15`, using the built-in Cedar and
Onyx voices. `provenance.json` records each exact input, voice, instruction,
generation time, final output hash and measured final RMS/peak levels. Text and translations live in
`shared/kill-voices.json` at the repository root.

The checked-in 24 kHz, 16-bit, mono WAVs are served as static assets. Playback
does not call any AI service. Surrounding silence was trimmed with an attack/tail
margin; brief edge fades and -6 dBFS peak normalization leave mix headroom.
The finished takes then receive one offline WSOLA time compression pass: each
clip has 80% of its former frame count (rounded to a whole sample), making it 20%
shorter while preserving pitch. Playback uses the normal sample rate and does not
compress them again. The processing records retain each former duration and hash.
An independent transcription check matched the intended words for all nine final
compressed clips. Pronunciation, performance and mix preference remain audition decisions.

To generate missing assets deliberately, run
`.tools/audio-analysis/bin/python scripts/generate-kill-voices.py --generate` from the repository root with
`OPENAI_API_KEY` configured. It makes paid requests only for missing files;
without `--generate` it prints the plan. This Python environment supplies NumPy
for `scripts/audio_processing.py`; another Python environment with NumPy also
works. Finishing includes the 20% compression and final-output measurements.
The credential never ships to browsers. Raw takes, per-clip generation records
and transcription checks belong in ignored `temp/kill-voices/`. After reviewing
new clips, copy their generation records into `provenance.json`.

Offline validation requires no service calls:
`.tools/audio-analysis/bin/python scripts/test-audio-processing.py` and
`.tools/audio-analysis/bin/python scripts/test-kill-voice-assets.py`.

Service documentation: <https://developers.openai.com/api/docs/guides/text-to-speech>
