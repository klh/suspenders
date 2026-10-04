# klh theme tokens — dark/light contract (W269, W291)

One theme layer for every klh GUI: the suspenders board (`/`), console pages
(`/console/*`), `/usage`, the belt dashboard (belt.local) and the klh-local
bar (bar.local). Source of truth: `hooks/lib/theme.ts` (tests:
`test/theme.test.ts`). belt and klh-local vendor it byte-identical as
`bin/klh-theme.ts` — see [Vendoring](#vendoring-belt-and-klh-local).

## Contract

- `<html data-theme="dark|light">` selects the palette. Components style with
  `var(--klh-*)` only — never a literal color. (Categorical data hues, e.g. the
  `/usage` model-group series, are data, not chrome, and stay fixed.)
- `<html data-theme-pref="light|dark|system">` mirrors the user's choice.
- Preference persists in `localStorage["klh-theme"]` (`light` | `dark`;
  absent = `system`). No server round-trip.
- `system` resolves through `prefers-color-scheme` and follows live OS flips.
  Without JS (or matchMedia) the page is dark — the historical look.
- No flash of wrong theme: the pre-paint script runs in `<head>`, before the
  first `<style>` that consumes tokens and before `<body>` paints.
- `window.klhTheme` = `{ pref(), resolve(pref), apply(), set(pref) }`.
  `set("system")` clears the key.
- Every apply dispatches `klh-themechange` on `document` with
  `detail: { theme, pref }` — canvas/chart code redraws on it (see
  `hooks/bin/usage-charts.ts`: uPlot strokes are functions reading
  `--klh-chart-*`, so a `redraw()` is all a theme flip needs).
- Other tabs follow via the `storage` event.

## Adopting it in another GUI

1. In `<head>`, first thing after `<meta charset>`: `THEME_HEAD`
   (`<style id="klh-theme-tokens" data-klh-theme="<version>">…</style><script>…pre-paint…</script>`).
   Non-TS GUIs: serve the output of
   `bun -e 'import {THEME_HEAD} from "./hooks/lib/theme.ts"; console.log(THEME_HEAD)'`.
2. Replace palette literals with tokens (tables below). Do not keep a
   `:root { color-scheme: … }` of your own — the token block sets it.
3. First thing in `<body>`: the fleet strip — `fleetNav("<site>")` plus
   `FLEET_NAV_CSS`, and `FLEET_NAV_JS` after the markup (section below).
4. Add the settings region to the right end of the page's own top bar
   (markup below) plus `THEME_SETTINGS_CSS` and, after the markup,
   `THEME_SETTINGS_JS`.

## Fleet strip (W291)

The fleet is three servers on three ports, not one app, so "one product" is a
shared look plus one shared row of links at the top of every dashboard:

| site         | link                       | port  | what it is                         |
| ------------ | -------------------------- | ----- | ---------------------------------- |
| `belt`       | `https://belt.local`       | :7791 | local LLM fleet status (belt)      |
| `suspenders` | `https://suspenders.local` | :7799 | fleet board + console (suspenders) |
| `local`      | `https://bar.local`        | :7792 | `.local` services bar (klh-local)  |

`fleetNav(site)` emits (titles elided; here `site` is `belt`):

```html
<nav class="klh-fleetnav" id="klh-fleetnav" aria-label="klh fleet">
  <span class="klh-fleetnav-brand">klh<i>·</i>fleet</span>
  <a href="https://belt.local" aria-current="page">belt</a>
  <a href="https://suspenders.local" data-repo="https://github.com/klh/suspenders">suspenders</a>
  <a href="https://bar.local" data-repo="https://github.com/klh/local">local</a>
</nav>
```

- Native `<nav>`/`<a>` only: no router, no iframe, no shared server. Each page
  still stands alone and works offline; nothing moves host or port.
- The page's own site carries `aria-current="page"` (ink + accent underline)
  and is never probed.
- `FLEET_NAV_JS` probes the other sites every 5 s while the tab is visible
  (`HEAD /ping`, `no-cors`: any HTTP answer means reachable). An unreachable
  site dims and its link points at its repo until it answers again. The
  script only toggles a class, `href` and `title`: no `innerHTML`, no DOM
  construction. Limitation: behind Caddy a stopped service still answers
  (502), so the probe detects "host unreachable", not "service down".
- Placement is the host page's call (the suspenders console sits the strip
  flush on `#cbar` with a panel ground); markup, links, type and colours are
  not.
- Terminology: the strip names _sites_. Inside suspenders the console menu
  names _pages_ — `belt gateway` (`/console/belt`), `fleet board` (`/`),
  `local services` (`/console/local`) — so no label points two places.
- The theme preference is per origin (localStorage), so belt.local,
  suspenders.local and bar.local each remember their own; `system` (the
  default) keeps them in step.

## Settings region markup

`settingsBlock(extra)` emits this (gear SVG elided); `extra` is where a GUI
appends its own fieldsets/links — the console adds
`<a href="/console/settings">all console settings →</a>`:

```html
<details class="klh-settings" id="klh-settings">
  <summary aria-label="settings" title="settings"><svg>…gear…</svg></summary>
  <div class="klh-settings-panel" role="group" aria-label="settings">
    <fieldset class="klh-theme">
      <legend>theme</legend>
      <label><input type="radio" name="klh-theme" value="light" /> light</label>
      <label><input type="radio" name="klh-theme" value="dark" /> dark</label>
      <label
        ><input type="radio" name="klh-theme" value="system" checked />
        system</label
      >
    </fieldset>
    <!-- extra: GUI-specific settings -->
  </div>
</details>
```

Native `<details>` gives keyboard + screen-reader disclosure for free;
`THEME_SETTINGS_JS` only binds the radios to `klhTheme.set`, re-syncs them on
`klh-themechange`, and closes the panel on outside click / Escape. No DOM is
constructed — no `innerHTML`.

## Tokens

| token               | dark                    | light                  |
| ------------------- | ----------------------- | ---------------------- |
| `--klh-bg`          | `#141413`               | `#f6f4ef`              |
| `--klh-field`       | `#121110`               | `#ffffff`              |
| `--klh-panel`       | `#171614`               | `#fbfaf7`              |
| `--klh-surface`     | `#1c1b19`               | `#ffffff`              |
| `--klh-overlay`     | `#1a1917`               | `#ffffff`              |
| `--klh-surface-hi`  | `#232220`               | `#ece9e2`              |
| `--klh-ink`         | `#e8e6e1`               | `#1c1b19`              |
| `--klh-ink-2`       | `#c3c2b7`               | `#3b3934`              |
| `--klh-ink-3`       | `#a5a29a`               | `#55524b`              |
| `--klh-dim`         | `#98958e`               | `#6b675f`              |
| `--klh-accent`      | `#d8900f`               | `#a86a00`              |
| `--klh-on-accent`   | `#141413`               | `#ffffff`              |
| `--klh-accent-bg`   | `#221f14`               | `#fbf1dc`              |
| `--klh-accent-wash` | `rgba(216,144,15,.12)`  | `rgba(168,106,0,.10)`  |
| `--klh-warm`        | `#221f1c`               | `#f8efe4`              |
| `--klh-danger`      | `#af2f12`               | `#af2f12`              |
| `--klh-danger-ink`  | `#c96a4f`               | `#a3361a`              |
| `--klh-danger-bg`   | `#221512`               | `#fbe9e4`              |
| `--klh-danger-edge` | `rgba(175,47,18,.6)`    | `rgba(175,47,18,.5)`   |
| `--klh-danger-wash` | `rgba(175,47,18,.16)`   | `rgba(175,47,18,.10)`  |
| `--klh-ok`          | `#5c7a35`               | `#5c7a35`              |
| `--klh-ok-ink`      | `#7da652`               | `#3f6a1c`              |
| `--klh-ok-hi`       | `#a5c78a`               | `#35591a`              |
| `--klh-ok-bg`       | `#1a2015`               | `#eaf3e0`              |
| `--klh-ok-wash`     | `rgba(92,122,53,.18)`   | `rgba(92,122,53,.14)`  |
| `--klh-info`        | `#8cbbad`               | `#2f7a68`              |
| `--klh-wash`        | `rgba(255,255,255,.03)` | `rgba(0,0,0,.025)`     |
| `--klh-edge-faint`  | `rgba(255,255,255,.07)` | `rgba(0,0,0,.07)`      |
| `--klh-edge-soft`   | `rgba(255,255,255,.10)` | `rgba(0,0,0,.10)`      |
| `--klh-edge`        | `rgba(255,255,255,.12)` | `rgba(0,0,0,.13)`      |
| `--klh-edge-mid`    | `rgba(255,255,255,.18)` | `rgba(0,0,0,.18)`      |
| `--klh-edge-strong` | `rgba(255,255,255,.24)` | `rgba(0,0,0,.24)`      |
| `--klh-edge-hover`  | `rgba(255,255,255,.4)`  | `rgba(0,0,0,.4)`       |
| `--klh-rule`        | `#2c2c2a`               | `#e2dfd8`              |
| `--klh-shadow`      | `rgba(0,0,0,.5)`        | `rgba(0,0,0,.14)`      |
| `--klh-chart-grid`  | `#2c2c2a`               | `#e2dfd8`              |
| `--klh-chart-hair`  | `#383835`               | `#cfcbc2`              |
| `--klh-chart-axis`  | `#898781`               | `#6b675f`              |

Roles: `bg` page base · `field` text inputs · `panel` top bar / sunk panels ·
`surface` cards · `overlay` drawers · `surface-hi` raised chips/avatars ·
`ink` → `ink-3` → `dim` text emphasis ladder · `accent` interactive amber,
`on-accent` text on an accent fill · `edge-*` borders by strength · `rule`
table dividers · `danger*` / `ok*` / `info` status families.

Lit components consume the same names (custom properties pierce shadow DOM),
e.g. `klh-decision-eval` uses `--klh-surface`, `--klh-ink`, `--klh-edge`,
`--klh-accent`, `--klh-dim`. Only names from these tables resolve: a typo
silently wears its `var(--klh-x, #hex)` fallback in both themes (W291 found
`klh-service-row` on `--klh-base` / `--klh-bad`, so its re-probe button was
black on black in light). `test/theme.test.ts` fails on any `var(--klh-*)`
under `hooks/` that THEME_CSS does not define.

## Scale tokens (W291)

Same value in both themes, emitted as their own `:root{…}` rule ahead of the
colour sets:

| token             | value                                                              |
| ----------------- | ------------------------------------------------------------------ |
| `--klh-font-mono` | `ui-monospace,SFMono-Regular,Menlo,Consolas,monospace`             |
| `--klh-font-sans` | `-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif` |
| `--klh-text-xs`   | `10px`                                                             |
| `--klh-text-sm`   | `11px`                                                             |
| `--klh-text-md`   | `12.5px`                                                           |
| `--klh-text-lg`   | `13px`                                                             |
| `--klh-text-xl`   | `14px`                                                             |
| `--klh-space-1`   | `2px`                                                              |
| `--klh-space-2`   | `4px`                                                              |
| `--klh-space-3`   | `8px`                                                              |
| `--klh-space-4`   | `12px`                                                             |
| `--klh-space-5`   | `16px`                                                             |
| `--klh-space-6`   | `20px`                                                             |
| `--klh-space-7`   | `28px`                                                             |
| `--klh-radius`    | `2px`                                                              |
| `--klh-radius-lg` | `3px`                                                              |

Roles: `font-mono` is the instrument face (belt, bar, the fleet strip, data
cells, inputs); `font-sans` is board/console prose. `text-xs` uppercase labels
and table heads · `text-sm` secondary text, buttons, the strip · `text-md` the
mono body (belt, bar) · `text-lg` the sans body (board, console) and marks ·
`text-xl` page titles. `radius` controls and chips, `radius-lg` panels and
popovers.

## Vendoring (belt and klh-local)

belt and klh-local run straight from copied `bin/` dirs with no
`node_modules`, so they vendor this file instead of importing it:

- `klh/belt bin/klh-theme.ts` and `klh/local bin/klh-theme.ts` are
  byte-identical copies of `hooks/lib/theme.ts` (pure, no imports). Their
  install scripts already copy all of `bin/`, so the copy ships with the page.
- `KLH_THEME_VERSION` names the bytes. `test/theme.test.ts` pins the sha-256
  of `theme.ts` to the version, so any edit here fails that test until the
  version is bumped and the pin updated.
- Each consumer's `test/klh-theme.test.ts` looks for a sibling `suspenders`
  checkout: same version means the bytes must match (drift fails); a
  different version skips with a re-vendor note.
- Live check: `curl -s https://belt.local | rg -o 'data-klh-theme="[^"]+"'`.

To change the theme: edit `hooks/lib/theme.ts`, bump `KLH_THEME_VERSION`,
update the pin, merge, then copy the file to `belt/bin/klh-theme.ts` and
`local/bin/klh-theme.ts` (one PR each).

Follow-up (W278): promote this to a versioned `klh-tokens` package once belt
and klh-local install dependencies at deploy time.
