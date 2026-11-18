# dsh-go-work

[![version](https://img.shields.io/badge/version-0.4.0-blue)](package.json)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[繁體中文](README.md) | [简体中文](README.zh-CN.md) | **English**

A browser automation plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It lets the AI drive a real Chrome window, read pages, and click elements — and it enforces what must not be done in code rather than in the prompt.

DSH already ships browser capability through `@playwright/mcp`. This plugin adds three things:

1. **Rules enforced by code.** Domain policy, password fields, payment wording, click count and session time limits are all decided in code, independent of the model's state.
2. **Visible operation.** The plugin launches Chrome itself, so the user can watch what it is doing without connecting through a debug pipeline.
3. **Controlled cost.** `gw_read` returns a compact element list instead of dumping the whole page HTML; screenshots are only produced when needed.

## Contents

- [Features](#features)
- [Kahoot in practice](#kahoot-in-practice)
- [Installation](#installation)
- [Usage](#usage)
- [Settings](#settings)
- [Tools](#tools)
- [Safety](#safety)
- [Limitations](#limitations)
- [Development](#development)
- [License](#license)

## Features

- **Six tools covering one complete workflow**: open, read, act, screenshot, fetch image, finish.
- **Domain policy rechecked at every step**: not only when entering a site, but after every action — including redirects and newly opened tabs.
- **Credential and payment protection**: `type=password` fields and payment, purchase and checkout wording are blocked; submit, send, publish and comment are allowed through.
- **Budget control**: both click count and session duration are capped, and Chrome is closed automatically when the time is up.
- **Compact reads**: the response is a list of interactive elements with `ref` handles, so the model targets elements by `ref` instead of guessing CSS selectors.
- **Original images**: images and CSS background images on the page are listed in the `images` field, and `gw_image` downloads the original file — clearer and cheaper than a screenshot.
- **Lifecycle management**: a manually closed Chrome is rebuilt on demand; `gw_done` and timeouts actually release resources.

## Kahoot in practice

Kahoot is not this plugin's main purpose — it is a convenient **test bench** with scoring and a countdown, because a single game exercises reading, clicking, dragging, typing and image recognition within a few dozen seconds. The actual main use is everyday browsing across arbitrary websites: looking things up, filling forms, booking tickets, reading forums, playing web games, all through the same set of `gw_*` tools.

Across long, repeated runs, the Kahoot total stays **above 80%**.

That comes from keeping the fixed cost of every step low enough to finish before the countdown, not from the model being especially clever:

- **Questions are read as text.** Questions, options and the countdown are all DOM text; one `gw_read` costs about 100 tokens, while a screenshot costs 1000+, and with twenty seconds per question there is usually no time.
- **Several actions in one call.** `gw_act` with `steps` merges "click the option → submit" into a single call, and every round trip saved is a few seconds gained.
- **Submit is never blocked.** Only payment and password are blocked; submit, send and publish go through — every quiz question needs a submit, and blocking it would make the game unplayable.
- **Repeat patterns are not relearned.** Chosen keywords and flows are stored in `~/.dsh/go-work.memory.json`, so the next game opens directly.

| Item | Measured result |
| --- | --- |
| Score | Steady above 80% (drops when the question bank is hard or the network is slow) |
| Read cost per question | About 100 tokens |
| Calls per question | 1 × `gw_read` + 1–2 × `gw_act` |
| Main source of lost points | The page switched questions between read and click; similar option wording |

> Scores depend on the model, the network and the difficulty of the question bank; the table is the author's measured average, not a guarantee.

### Single-game record (2026-11-18)

| Question bank | Questions | Correct | Score | Rank | Reference |
| --- | --- | --- | --- | --- | --- |
| Wikipedia (classic mode, 10 bots) | 9 | 9 | 9719 | 3 / 10 | Winner scored 12 013, so about 80.9% of it |

This game used the [Wikipedia question bank](https://create.kahoot.it/solo?quizId=eb8e6cc3-f9e7-4df1-b8d2-dd81351ecef5&gameMode=normal): 9 questions, 10 bot opponents.

Per-question scores: 928, 584, 928, 926, 912, 2064, 925, 1530, 922. The game took 255 seconds and 31 clicks; every question was read as text, and only the one image question downloaded the original picture.

### Capabilities exercised in this game

Every item below is a general capability, not something Kahoot-specific:

1. **Text questions**: `gw_read` answered straight from the DOM — Everest as the world's highest peak, the Grand Canyon in Arizona, the Cliffs of Moher not in Scotland (no), Mount Fuji in Japan.
2. **Drag ordering**: `gw_act` `drag` pulled TU to the first slot to spell TURKEY (+584). A drag only registers when it crosses two or more rows, and the visual order has to be confirmed with a screenshot.
3. **Multi-select**: all six Mount Fuji statements selected (+2064). When options are not in `elements`, click by coordinates; one `steps` call made all six selections plus the submit, seven clicks in total.
4. **Text input**: `type` filled in Japan and the answer was submitted (+912).
5. **Image recognition**: Victoria Falls was identified from the original picture downloaded with `gw_image` (+1530) — clearer and cheaper than a screenshot.
6. **State reading**: after answering, tell "next question" apart from a Wikipedia bonus page; an `aria-hidden` button means the page has already moved on and must not be forced.

The drag-to-order question (584) and the picture question were the main time sinks. The same question bank also has a 10 299 record; almost all of that gap is answer latency — which is exactly why reducing round trips is this plugin's first principle.

## Installation

Verified on Windows only. Requires a working Chrome and the DSH desktop app.

### Option 1: let DSH install it (recommended)

```powershell
dsh plugin --profile <profile> add "C:\path\to\dsh-go-work"
```

Replace `<profile>` with the profile to install into (`desktop`, `web`, …) and the path with your clone. DSH links the folder with pnpm, appends `dsh-go-work` to that profile's `dsh.profile.bundles`, and applies the plugin's own `cordis.patch.yml`, so no settings file needs editing.

> If the path contains non-ASCII characters (for example `OneDrive\文件`), the `link:` written into the profile may look garbled, though the link itself still works. If loading fails, use Option 2.

### Option 2: mount it by hand

1. Clone the source into the `dsh-go-work` folder of your workspace:

   ```powershell
   git clone https://github.com/Udon081112/dsh-go-work.git
   ```

   Alternatively use **Code → Download ZIP** on the GitHub page and unpack it.

2. Link the plugin into the DSH profile (`<workspace>` is the real path):

   ```powershell
   cmd /c mklink /J "C:\Users\<user>\.dsh\profiles\desktop\node_modules\dsh-go-work" "<workspace>\dsh-go-work"
   ```

3. Add the insertion point to `~/.dsh/profiles/desktop/cordis.patch.yml`:

   ```yaml
   - id: go-work
     name: dsh-go-work
     disabled: false
   ```

4. Restart DSH. The host side loads the module only at startup, so changes under `lib/` require a restart; the settings page is client-side and only needs a page refresh.

5. Check the load state: `phase` in `~/.dsh/go-work.diag.json` should be `ready` and `toolErrors` should be empty. `GET /dsh-go-work/api/ping` returns the same diagnostic record.

## Usage

The model picks tools on its own. A typical run looks like this:

```
User: finish this Kahoot question for me, code 123456
Model: (gw_goto kahoot.it) → (gw_read) read the question and options
       (gw_act click e3) → next question
       (gw_act steps:[…]) finish several steps in a row
       (gw_done) report the result
```

When the model has to decide where to go, it searches once and hands the candidates to the user:

```
Model: (gw_goto q="tic tac toe online")
       → returns the top 3 results and shows a "which one?" decision card
User: the second one
Model: (gw_goto url=…) → (gw_read) → (gw_act click e5) …
```

Once a keyword has been chosen, the choice is stored in `~/.dsh/go-work.memory.json` (kept 30 days, up to 200 entries); the next run opens it directly without searching or asking again.

When it meets a password field or needs to press payment, purchase or checkout, the tool returns the blocking reason and the model goes back to the user. The plugin never opens dialogs, and it never blocks submit, send, publish or comment — every Kahoot question needs a submit, and blocking it would make the quiz impossible.

## Settings

After installation, the DSH settings page gains an "AI browser" section; settings live in `~/.dsh/go-work.config.json`.

| Setting | Description | Default |
| --- | --- | --- |
| Enable browser tools | Master switch. When off, the six tools still exist but each returns "disabled" | On |
| Which Chrome to use | Clean profile only: a fresh one per session, with no local sign-in state | `clean` |
| Domain policy | No restriction, blocklist, or allowlist (including subdomains) | `off` |
| Domain list | One domain per line, e.g. `bilibili.com`; an empty allowlist blocks everything | empty |
| No password entry | Blocks `type=password` fields, including coordinate clicks and character-by-character typing | On |
| No payment | Blocks payment, purchase and checkout wording; submit, publish and comment are allowed | On |
| Max clicks | Click limit for a single session | `200` |
| Max minutes | Chrome is closed automatically when time is up, without waiting for the next call | `30` |
| Screenshots | "On demand" or "Off"; when off, `gw_shot` is refused while `gw_image` is unaffected | `onDemand` |
| Save location | Folder for screenshots and images, default `~/.dsh/im/screenshot`; leave empty to skip saving and return only the file size | `~/.dsh/im/screenshot` |

The settings page can only project `id`, `order` and `label`; there is no slot for an icon, so `icon.svg` is only useful to other hosts.

## Tools

| Tool | Purpose |
| --- | --- |
| `gw_goto` | Open a URL with `url` (domain policy applies), or search with `q` — returns 3 candidates and shows a decision card |
| `gw_read` | Read the page: first 1500 characters of text, the first 12 interactive elements with `ref`, and the image list |
| `gw_act` | Run `click`, `type`, `select`, `press`, `scroll` or `drag`; `steps` performs several actions in a row |
| `gw_shot` | Take a screenshot and return its file path (last resort) |
| `gw_image` | Download the original file of a page image, then view it with `read_image` |
| `gw_done` | Close Chrome and report click count and elapsed time |

`gw_read` returns an element list, never the full page HTML. The model targets elements by `ref`, which saves tokens and avoids clicking the wrong spot. The defaults are deliberately small (12 elements, 1500 characters); callers can ask for more.

### `gw_act` call forms

| Form | Purpose |
| --- | --- |
| `{ action:'click', ref:'e3' }` | Ordinary click |
| `{ action:'click', x:420, y:300 }` | Canvas or iframe games have no `ref`; use screenshot pixel coordinates (viewport 1:1) |
| `{ action:'type', ref:'e5', text:'123456' }` | Enter text |
| `{ action:'select', ref:'e7', text:'Taiwan' }` | `<select>` dropdown; falls back to `value` when the label is not found |
| `{ action:'press', key:'Enter' }` | Press a key on the focused element |
| `{ action:'drag', x:100, y:200, x2:400, y2:200 }` | Ordering questions, drag and drop |
| `{ action:'scroll', dy:600 }` | Scroll the page |
| `{ steps:[{action:'click',ref:'e1'},{action:'click',ref:'e2',waitMs:500}] }` | Consecutive actions, up to 30 steps |

Password protection does not depend on the entry point: filling by `ref`, clicking by coordinate, and clicking into the field first then typing character by character are all blocked.

When plain text is enough, do not take a screenshot. Kahoot questions, options and the countdown are DOM text, and one `gw_read` costs about 100 tokens; a screenshot costs 1000+ tokens, and with twenty seconds per question it is usually too slow.

### Budgets and hints

- Three consecutive `gw_read` calls on the same page with no action return `stuck: true`, asking the model to act immediately or report where it is stuck.
- At most two search rounds per navigation; the budget is reset when the browser closes, so it never leaks into the next task.

## Safety

The domain policy has three modes: `off`, `blocklist` and `allowlist` (subdomains included).

Since 0.4.0 every action re-checks the resulting URL: clicks, typing, key presses, drags, dropdowns, redirects and new tabs are all covered; a policy hit returns to the previous page and reports the reason.

The only exception is the search engine itself. In allowlist mode the listed domains never include Bing, DuckDuckGo or Google; without letting the engine through, `gw_goto { q }` would be unusable. The URL the user finally picks still goes through the domain policy.

Two points must be understood clearly:

- This is **workflow-level** blocking, not a sandbox. It constrains the actions the plugin itself issues; it does not limit what the opened website can do.
- Only payment, purchase, checkout and password fields are blocked; other sensitive actions (deleting an account, for example) are out of scope.

## Limitations

- **DOM inside iframes cannot be read.** `gw_read` reads the top page only; with iframes (Poki-style games, for example) the response reports `frames` and suggests screenshots plus coordinate actions.
- **No timed screenshots.** Screenshots happen only when the model asks.
- **One browser instance at a time.** Concurrent tasks share the same window and interfere with each other.
- **New tabs are only adopted passively.** Extra tabs are never closed, but the most recently opened one becomes the current page and goes through the domain policy as well.
- **No reuse of an existing Chrome profile.** Every session starts clean.

## Development

No TypeScript and no build step.

```
package.json          declares the dsh fields for bundle and client
cordis.patch.yml      plugin insertion point
LICENSE               MIT
lib/index.js          host side: settings I/O, HTTP routes, tool registration, diagnostics
lib/tools.js          definitions of the six tools (zero dependencies)
lib/browser.js        Chrome lifecycle, ref table, policy checks, actions
lib/client.js         client side: the settings page (hand-written React)
test/smoke.mjs        structural tests that never launch a browser
test/live.mjs         end-to-end test that really opens Chrome
```

The plugin has no dependencies of its own; Playwright is borrowed from an existing installation:

- run `npm i playwright` in the plugin folder to install it into the local `node_modules` (cleanest option);
- or use the `@playwright/mcp` installation of the DSH experimental browser plugin (`~/.dsh/mcp/browser/node_modules/playwright`);
- or use a globally installed npm copy;
- or point `DSH_GO_WORK_PLAYWRIGHT` at a playwright folder.

`@playwright/mcp` is Microsoft's official package (Apache-2.0). It is neither part of this plugin nor shipped with the DSH core; it is present locally because DSH's experimental plugin `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp` uses it and installs it into `~/.dsh/mcp/browser` on first run. When nothing is found, the tool lists every path it tried. Chrome works the same way through `DSH_GO_WORK_CHROME`.

```bash
npm run check        # syntax check of the four files
npm test             # smoke: 12 groups, no browser
npm run test:live    # really opens Chrome once (a window pops up, about 5 seconds)
```

When debugging, start with `~/.dsh/go-work.diag.json`: the `phase` it stopped at is where the failure is. `GET /dsh-go-work/api/ping` returns the same record.

> `test/live.mjs` needs to spawn a Chrome child process (Playwright uses remote-debugging-pipe). In a restricted sandbox it fails with `spawn EPERM`; that is an environment limit, not a plugin bug. Run it from a normal DSH host process.

## License

MIT, see [LICENSE](LICENSE).
