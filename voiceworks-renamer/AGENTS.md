# AGENTS.md

Agent guide for `voiceworks-renamer`.

## Scope

Python desktop app for metadata-driven audio renaming and playlist generation.

## Key Modules

- `main.py`: app entrypoint.
- `renamer.py`: core rename workflow.
- `metadata_handler.py`: metadata extraction/fallback.
- `scanner/` + `scanner.py`: file discovery.
- `transcriber.py`: transcription integration.
- `settings_panel.py`, `modern_frame.py`: UI configuration.

## Development Commands

```bash
pip install -r requirements.txt
python main.py
python build.py
python test_title_cleaner.py
```

## Engineering Rules

- Preserve rename determinism; never rename on partial/uncertain metadata without explicit fallback logic.
- Keep filesystem operations safe and reversible where possible.
- Prefer explicit typing (type hints) for new/modified Python functions.
- Add focused tests when changing string cleanup, parsing, or rename rules.

## Data & Config

- Runtime config/state files: `config.json`, `cache.db`, `playlists.db`.
- Do not hand-edit DB files in commits.
- Maintain backward compatibility for existing config keys.

## Change Checklist

1. Validate with `python test_title_cleaner.py`.
2. Smoke test rename flow on a sample folder.
3. Confirm no accidental destructive file operations.
4. Update README/docs when behavior changes.
