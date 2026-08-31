# headless-browser

A stateful Playwright extension for Pi. It provides `headless_browser` for frontend testing and general browser navigation, interaction, inspection, rendering, and deterministic Markdown extraction, plus `web_search` for API-key-free web discovery.

## Isolation

The extension lazily creates a private directory under the operating system's temporary directory. Every `@playwright/cli` invocation uses that directory as its working directory, and the CLI daemon/session directory is redirected there too.

The project working directory is never used for browser output. In particular, Playwright's automatic `.playwright-cli/` snapshots cannot appear in the repository.

Temporary data includes:

- automatic and requested snapshots
- screenshots, PDFs, and extracted Markdown
- browser profile/session data
- saved authentication state
- search intermediates and full output from truncated commands

The directory is removed on normal Pi session shutdown. An abrupt process kill can leave an OS-temporary directory for the operating system to clean later. Existing Playwright browser binaries remain in Playwright's normal installation cache.

Uploads are the one intentional project interaction: a relative upload path is resolved against Pi's project cwd and read by the browser. The extension still does not write there.

## Install

```bash
cd ~/repositories/pi-extensions/personal-extensions/extensions/headless-browser
npm install
```

If no compatible browser is installed:

```bash
npm run setup
```

Then symlink the package-style extension into Pi's global extension directory:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s ~/repositories/pi-extensions/personal-extensions/extensions/headless-browser \
  ~/.pi/agent/extensions/headless-browser
```

Reload Pi with `/reload`, or test it directly:

```bash
pi -e ~/repositories/pi-extensions/personal-extensions/extensions/headless-browser
```

## Workflow

The extension exposes two sequential tools:

- `headless_browser` — stateful, low-level browser navigation and interaction
- `web_search` — structured web results from a disposable Google tab with DuckDuckGo HTML fallback

Typical flow:

1. Use `web_search` to discover relevant pages, or `headless_browser` action `open` for a known URL.
2. `snapshot` the page to obtain refs such as `e12`.
3. Use refs with `click`, `fill`, `select`, `check`, and similar actions.
4. Inspect with `console`, `requests`, `request`, `eval`, or `run_code`.
5. Use `extract_markdown` for deterministic readable content, or render with `screenshot`/`pdf`.
6. `close` when finished. Session shutdown also closes and cleans up automatically.

`extract_markdown` captures the current rendered DOM, uses Mozilla Readability to isolate main content, and converts it locally with Turndown. No model participates in conversion. Given identical rendered HTML, dependency versions, and configuration, the Markdown is deterministic; dynamic pages can still produce different rendered HTML.

Google search runs in a disposable tab and closes it afterward, preserving the previously active page. If Google presents blocking or CAPTCHA signals, `web_search` falls back to DuckDuckGo's HTML endpoints. Search-engine markup can change, so this no-key approach is less stable than a supported search API.

Screenshots are attached inline when they are at most 10 MB. Every artifact path returned by the tool points into the temporary workspace and is not durable. Copying an artifact into a permanent location should be an explicit user decision.

## Useful actions

- Navigation: `open`, `goto`, `back`, `forward`, `reload`, `new_tab`, `tabs`, `select_tab`, `close_tab`
- Page structure and content: `snapshot`, `find`, `extract_markdown`
- Interaction: `click`, `dblclick`, `fill`, `type`, `press`, `hover`, `select`, `check`, `uncheck`, `upload`, `mousewheel`
- Inspection: `console`, `requests`, `request`, `eval`, `run_code`
- Rendering: `screenshot`, `pdf`
- Session helpers: `resize`, `wait`, `save_state`, `load_state`, `close`

## Verify

The repository-wide checks cover the extension's TypeScript and unit tests:

```bash
cd ~/repositories/pi-extensions/personal-extensions
npm run check
npx vitest run extensions/headless-browser
```

Run the browser smoke test from the extension directory:

```bash
npm run smoke
```
