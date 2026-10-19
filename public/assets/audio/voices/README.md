# Original character voice clips

These nine mono WAV clips are AI-generated performances of original fictional
British, German and Russian soldier lines. No recording or imitation of a named
person was used. The app discloses their AI origin in Sound review and Credits.

Generated with OpenAI `gpt-4o-mini-tts-2025-12-15`, using the built-in Cedar and
Onyx voices. `provenance.json` records each exact input, voice, instruction,
generation time, output hash and measured level. Text and translations live in
`shared/kill-voices.json` at the repository root.

The checked-in 24 kHz, 16-bit, mono WAVs are served as static assets. Playback
does not call any AI service. Surrounding silence was trimmed with an attack/tail
margin; brief edge fades and -6 dBFS peak normalization leave mix headroom.
An independent transcription check matched the intended words for all nine final
clips. Pronunciation, performance and mix preference remain audition decisions.

To generate missing assets deliberately, run
`python3 scripts/generate-kill-voices.py --generate` from the repository root with
`OPENAI_API_KEY` configured. It makes paid requests only for missing files;
without `--generate` it prints the plan. The credential never ships to browsers.
Raw takes and transcription checks belong in ignored `temp/kill-voices/`.

Service documentation: <https://developers.openai.com/api/docs/guides/text-to-speech>
