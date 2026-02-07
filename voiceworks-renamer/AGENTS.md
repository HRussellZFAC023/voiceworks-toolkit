# Repository Guidelines

## Project Structure & Module Organization
- Core application code lives in the repository root as Python modules (for example `main.py`, `renamer.py`, `scraper/`, `scanner/`).
- UI and helper modules include `modern_frame.py`, `my_frame.py`, and `settings_panel.py`.
- Configuration and local state are stored in `config.json`, `cache.db`, and `playlists.db`.
- Build outputs go to `build/` and `dist/` (default executable at `dist/main.exe`).
- Scripts imported from other tools can be placed in `__scripts__/` (see `README.md` for the RJ-code layout).

## Build, Test, and Development Commands
- `pip install -r requirements.txt` installs Python dependencies (Python 3.9 expected).
- `python main.py` runs the desktop app locally.
- `python build.py` packages the app with PyInstaller (outputs to `dist/`).
- `python test_title_cleaner.py` runs the existing standalone test script for title cleanup.

## Coding Style & Naming Conventions
- Python code uses 4-space indentation and standard PEP 8 naming (snake_case functions/variables, CapWords classes).
- Keep modules single-purpose and organized by feature (scanner, scraper, metadata, renamer).
- There is a minimal `.pylintrc`; if you add linting, keep rules light and consistent with existing style.

## Testing Guidelines
- Tests are currently ad-hoc: `test_title_cleaner.py` is the only test script.
- Name new tests `test_*.py` and keep them runnable via `python <file>` unless you add a test runner.
- If you introduce a test framework (pytest), document the new command here.

## Commit & Pull Request Guidelines
- Git history shows concise, imperative messages (e.g., "Refactor ...", "Add ..."), with occasional tags like "wip" or "v1". Prefer descriptive, single-line summaries and avoid "wip" on main branches.
- PRs should include: a short summary, testing notes (commands run), and any user-facing screenshots for UI changes.

## Configuration & Data Notes
- `config.json` drives renaming and scraping behavior; update defaults carefully and keep backward compatibility when possible.
- Local caches (`cache.db`, `playlists.db`) are generated artifacts and should not be edited by hand.
