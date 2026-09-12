# pi-browser-actions

Stateful Playwright browser automation for [Pi](https://github.com/earendil-works/pi-mono). Open a headed or headless browser, attach to an existing browser, interact with pages, inspect frontend behavior, render artifacts, extract readable Markdown, and search the web.

## Install

The package requires Node.js `^22.22.2`, `^24.15.0`, or `>=26.0.0`.

```bash
pi install npm:pi-browser-actions
```

Install the matching Chromium build once if Playwright reports that it is missing:

```bash
npm exec --yes --package=@playwright/cli@0.1.19 -- playwright-cli install-browser chromium
```

Test without installing permanently:

```bash
pi --no-extensions -e npm:pi-browser-actions
```

## Tools

### `browser_session`

Starts and releases the stateful Playwright session used by `browser`. Only this compact session tool is initially active; a successful `open` or `attach` progressively enables the larger `browser` tool for the next model response.

Open a headless browser:

```json
{ "action": "open", "url": "https://example.com" }
```

Open a visible browser window:

```json
{ "action": "open", "url": "https://example.com", "headed": true }
```

The default browser is Playwright's bundled Chromium. Explicit browser choices are `chrome`, `firefox`, `webkit`, and `msedge`.

Session actions are `open`, `attach`, `detach`, `close`, and `list_sessions`.

### `browser`

Controls the active page after `browser_session` has opened or attached it. Use `snapshot` before ref-based interaction.

Useful action groups:

- Navigation: `goto`, `back`, `forward`, `reload`, `new_tab`, `tabs`, `select_tab`, `close_tab`
- Page content: `snapshot`, `find`, `extract_markdown`
- Interaction: `click`, `dblclick`, `fill`, `type`, `press`, `hover`, `select`, `check`, `uncheck`, `upload`, `mousewheel`
- Inspection: `console`, `requests`, `request_details`, `eval`, `run_code`
- Rendering: `screenshot`, `pdf`
- State: `save_state`, `load_state`

Call `requests` first, then pass one of its indexes to `request_details`. Successful `eval` and `run_code` responses omit the CLI's echoed source block. A complete diagnostic artifact is exposed only when output is truncated.

Screenshots are saved as full-resolution JPEG temporary artifacts and attached to the model as JPEG previews downscaled to fit within 1600×1600. General output is capped at 2,000 lines or 50 KB. Snapshots use a smaller 500-line/20 KB model-facing budget; truncation preserves the exact leading content and links to the complete temporary output artifact.

Default command timeouts are 20 seconds for ordinary actions, 45 seconds for navigation, and 60 seconds for open/attach. `timeoutMs` overrides these defaults.

### Attaching to an existing browser with `browser_session`

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

`detach` disconnects explicitly. Calling `close` or ending the Pi session also detaches an externally owned browser; it never closes that browser. Browsers launched by this package are closed normally. Repeating a compatible `open` reuses the active browser and navigates it when a URL is supplied; repeating the same `attach` reuses the attachment. Different launch or attachment options still require `close` or `detach` first.

### `web_search`

In the default `auto` mode, an `openai-codex` model uses OpenAI's native web-search capability first. Search then uses the Brave Search API when `BRAVE_SEARCH_API_KEY` is set, and falls back to DuckDuckGo HTML when the preceding provider is unavailable, fails, or returns no results.

```bash
export BRAVE_SEARCH_API_KEY="your-api-key"
```

Set `provider` to call one implementation without fallback, which is useful for testing:

```json
{ "query": "Pi coding agent", "provider": "brave", "maxResults": 5 }
```

Supported values are `auto`, `native`, `brave`, and `duckduckgo`. `native` requires the current model provider to be `openai-codex`; `brave` requires `BRAVE_SEARCH_API_KEY`. Native search returns a concise cited summary, while Brave and DuckDuckGo return structured titles, URLs, and snippets.

The search engine behind OpenAI's native search is not exposed by its API. Brave and DuckDuckGo responses are limited to 2 MB, and DuckDuckGo's HTML can change.

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

`@playwright/cli@0.1.19` is a stable CLI package release but currently pins an alpha Playwright build internally. The package and lockfile fix the exact CLI and Playwright builds; run the full release checks before accepting upgrades.

## License

MIT
