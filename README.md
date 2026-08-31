# pi-browser-actions

Stateful Playwright browser automation for [Pi](https://github.com/earendil-works/pi-mono). Open a headed or headless browser, attach to an existing browser, interact with pages, inspect frontend behavior, render artifacts, extract readable Markdown, and search the web.

## Install

The package requires Node.js `^22.22.2`, `^24.15.0`, or `>=26.0.0`.

```bash
pi install npm:pi-browser-actions
```

Install the matching Chromium build once if Playwright reports that it is missing:

```bash
npm exec --yes --package=@playwright/cli@0.1.18 -- playwright-cli install-browser chromium
```

Test without installing permanently:

```bash
pi --no-extensions -e npm:pi-browser-actions
```

## Tools

### `browser`

Controls one stateful Playwright session. Start with `open` or `attach`, then use `snapshot` before ref-based interaction.

Open a headless browser:

```json
{ "action": "open", "url": "https://example.com" }
```

Open a visible browser window:

```json
{ "action": "open", "url": "https://example.com", "headed": true }
```

The default browser is Playwright's bundled Chromium. Explicit browser choices are `chrome`, `firefox`, `webkit`, and `msedge`.

Useful action groups:

- Session: `open`, `attach`, `detach`, `close`, `list_sessions`
- Navigation: `goto`, `back`, `forward`, `reload`, `new_tab`, `tabs`, `select_tab`, `close_tab`
- Page content: `snapshot`, `find`, `extract_markdown`
- Interaction: `click`, `dblclick`, `fill`, `type`, `press`, `hover`, `select`, `check`, `uncheck`, `upload`, `mousewheel`
- Inspection: `console`, `requests`, `request`, `eval`, `run_code`
- Rendering: `screenshot`, `pdf`
- State: `save_state`, `load_state`

Screenshots are attached inline up to 10 MB. Tool output is capped at 2,000 lines or 50 KB; truncated full output remains available only in the temporary workspace.

### Attaching to an existing browser

List discoverable Playwright sessions and supported local browser channels:

```json
{ "action": "list_sessions" }
```

Attach using exactly one target:

```json
{ "action": "attach", "name": "shared-browser" }
```

```json
{ "action": "attach", "cdpEndpoint": "http://localhost:9222" }
```

```json
{ "action": "attach", "browserServerEndpoint": "ws://localhost:3000/playwright" }
```

```json
{ "action": "attach", "attachViaExtension": true, "browser": "chrome" }
```

CDP attachment requires Chrome or Edge to expose a remote-debugging endpoint. Browser-extension attachment requires the Playwright browser extension. A normal browser process without CDP, a Playwright browser-server endpoint, or the extension cannot be attached.

`detach` disconnects explicitly. Calling `close` or ending the Pi session also detaches an externally owned browser; it never closes that browser. Browsers launched by this package are closed normally.

### `web_search`

Searches without an API key. It uses a disposable Google tab first and falls back to DuckDuckGo HTML when Google blocks automated access. The previously active tab is preserved.

Search-engine HTML can change, so this is less stable than a supported search API. DuckDuckGo responses are limited to 2 MB.

## Isolation and trust model

Pi extensions execute arbitrary code with the user's full system permissions. Install this package only from a source you trust and review changes before upgrading.

The package lazily creates a private operating-system temporary directory. Playwright's working directory, daemon metadata, profiles, snapshots, screenshots, PDFs, saved authentication state, Markdown, and logs remain there. Normal Pi session shutdown releases the named browser session and removes the directory.

Uploads are the intentional exception: relative paths resolve against Pi's project working directory. Absolute paths and parent-directory traversal are accepted, so `upload` can read any file available to the Pi process. The package never writes to project paths.

This package is an automation tool, not a security sandbox:

- Pages, search results, console messages, and extracted Markdown are untrusted data.
- Browser actions can reach localhost and private-network services available from the host.
- `eval` and `run_code` can inspect and act through the current browser session, including its cookies and storage.
- Saved authentication state remains sensitive for the lifetime of the Pi session.

Only access local services, execute page code, or upload local files when the user's task requires it.

## Markdown extraction limits

`extract_markdown` captures the rendered DOM, isolates main content with Mozilla Readability, and converts it locally with Turndown. It rejects rendered HTML over 5 MB and intermediate capture data over 12 MB before constructing JSDOM.

## Development

```bash
npm install
npm run setup
npm run check
npm test
npm run smoke
npm run smoke:attach
npm run smoke:headed
npm run pack:dry
```

Install additional engines explicitly:

```bash
npm run setup:browsers
npm run setup:edge
```

`@playwright/cli@0.1.18` is the latest non-prerelease CLI package but currently pins an alpha Playwright build internally. The lockfile fixes the exact build; run the full release checks before accepting CLI upgrades.

## License

MIT
