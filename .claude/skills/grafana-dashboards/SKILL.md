---
name: grafana-dashboards
description: Use when designing or building an operator dashboard, monitoring UI, status page, metrics panel, stat tile, gauge, sparkline, or KPI row - the Grafana way, distilled with exact light-theme token values. Covers the 24-column grid and row composition, which panel type answers which question, threshold and color semantics (base/ok/warn/critical), units and number formatting, the sparkline-in-stat pattern, and dashboard-authoring rules. Read before adding a panel to the control room UI or any new dashboard.
---

# Operator dashboards, the Grafana way

Distilled from the upstream Grafana source, `github.com/grafana/grafana`. Every
number here is copied from that repository; file paths are cited so you can
check them yourself.
Long tables (full palette, all unit families, per-panel option lists) are in
`reference.md` next to this file.

**The one rule everything else serves:** a dashboard tells a story or answers a
question. If it has no goal, you don't need it.
(`docs/sources/visualizations/dashboards/build-dashboards/best-practices/index.md`)

---

## 1. Layout

Grafana's dashboard is a **24-column grid**. From
`public/app/core/constants.ts`:

| Constant | Value | Means |
|---|---|---|
| `GRID_COLUMN_COUNT` | 24 | columns across the full width |
| `GRID_CELL_HEIGHT` | 30 | px per height unit |
| `GRID_CELL_VMARGIN` | 8 | px gutter between cells |
| `MIN_PANEL_HEIGHT` | 90 | `GRID_CELL_HEIGHT * 3` |
| `DEFAULT_PANEL_SPAN` | 4 | default width in old span units |

24 divides cleanly, which is the whole point. Useful widths: `24` full, `12`
half, `8` thirds, `6` quarters, `4` sixths, `3` eighths. A KPI row is six stats
at `w:4`; a detail row is two time series at `w:12`.

**Composition, outside-in** (`.../create-dashboard/dashboard-groupings.md`):

```
dashboard  ->  row or tab  ->  (nested row or tab)  ->  panels
```

Rows and tabs are the only grouping primitives. Rows nest in rows, rows nest in
tabs, tabs nest in rows — but never a tab directly inside a tab. Max four
grouping levels (six configuration levels including dashboard and panel).

Row options that matter: **Title**, **Fill screen**, **Hide row header**, and
**Layout** (`Custom` for hand-placed panels, `Auto grid` for equal tiles).

**The canonical operator layout, top to bottom:**

1. **Status row** — 4-6 stat panels, `h:4 w:4`. The answer to "is anything on
   fire?" with no scrolling and no reading.
2. **Rate / error / duration row** — time series, `h:8 w:12` pairs. Request and
   error rate on the left, latency on the right, one row per service, rows
   ordered to follow the data flow.
3. **Detail row** — table or bar gauge, `h:8-10 w:24`. The list you drill into
   after the top two rows told you where to look.
4. **Text panel** (optional) — what this dashboard is for, who owns it, links to
   the neighbours. Put documentation *in* the dashboard.

Large-to-small, general-to-specific. Aggregates first, then the breakdown.

---

## 2. Panel types: which question does it answer?

| Panel | Answers | Use when | Don't |
|---|---|---|---|
| **Stat** | "What is it right now?" | Latest/current value of a series, optionally with a sparkline behind it and percent change. Key metrics at a glance, aggregates like mean response time, values you want colored when they cross a threshold. | Don't use for more than ~8 tiles; it stops being glanceable. |
| **Gauge** | "Where in the allowed range?" | A value with a *meaningful* min and max: SLO attainment, disk fullness, CPU 0-100%, a set point with alarm thresholds. | Don't use without a real min/max — a gauge with an inferred range is a lie. |
| **Bar gauge** | "How do these compare against the same range?" | Several KPIs or entities sharing a scale: per-service health, completion rates, savings against goal. Reads as a thermometer, not a bar chart. | Don't use for time on the x-axis. |
| **Time series** | "How did it change?" | The default for anything with a timestamp. Lines, points, or bars. Large numbers of points that a table cannot hold. | Don't stack by default — stacking hides data and misleads. Requires unique timestamps per series. |
| **Table** | "Which specific rows?" | Logs, traces, per-entity detail, anything spreadsheet-shaped. Cells can carry colored text/background, gauges, sparklines, links. | Needs a complete column-row structure; one missing cell and the table renders nothing. No annotations or alerts. |
| **Text** | "What am I looking at?" | Dashboard documentation, ownership, links to sibling dashboards, maintenance notices. Markdown, HTML, or code mode. | Don't hide instructions in a panel description when everyone needs them. |

Panel-level documentation goes in the panel **description** — it surfaces on the
small `i` in the panel's top-left corner.

Sources: `docs/sources/visualizations/panels-visualizations/visualizations/{stat,gauge,bar-gauge,time-series,table,text}/index.md`.

---

## 3. Thresholds and color semantics

A threshold is a value that changes the visual when met or exceeded. Grafana's
defaults (`.../configure-thresholds/index.md`):

- **Base = green**, and Base means *minus infinity*, not zero.
- **80 = red.**
- Mode = **Absolute**.

Thresholds are sorted highest to lowest automatically. Two modes: **Absolute**
(a number on the field's own scale) and **Percentage** (relative to min/max —
this is why Min and Max are standard options).

**The semantic ladder to use here.** Four steps, not a gradient:

| Step | Meaning | Light-theme color | Source |
|---|---|---|---|
| base | normal / good | `#56A64B` (viz `green`) | light hues, `createVisualizationColors.ts` |
| ok→warn | attention, not yet broken | `#FF780A` (viz `orange`) | same |
| warn→critical | breached, act now | `#E02F44` (viz `red`) | same |
| unknown / no data | not measured | `text.disabled`, `rgba(36, 41, 46, 0.65)` | `createColors.ts` |

Do not add a fifth color to a threshold ladder. If you need a fifth, you have two
questions in one panel.

**Where thresholds show up per panel:** color the value or the background in a
stat; the gauge arc and threshold markers in a gauge; grid lines and filled
regions in a time series (options: off / lines / dashed lines / filled regions /
regions+lines / regions+dashed); region colors in a state timeline; cell text or
background in a table.

**Color scheme choice** (`.../configure-standard-options/index.md`):

| Scheme | Use for |
|---|---|
| **From thresholds (by value)** | Every status/health panel. This is the default you want. |
| **Single color** | A single series whose identity, not its value, matters. |
| **Classic palette** | Categorical series in a time series or pie chart. Colors follow *order*, so they shift when a query's field order changes. |
| **Classic palette (by series name)** | Same, but stable when the set of series changes. Prefer this over plain Classic. |
| **Multiple continuous colors (by value)** | Heatmap-like density only. Green-Yellow-Red etc. |
| **Single continuous color (by value)** | Shades of one hue by percentage of min-max. Good for a "more is more" metric with no good/bad meaning. |

**Avoid the rainbow.** Grafana's own guidance: "expressive charts with meaningful
use of color." Blue means it's good, red means it's bad. A palette that assigns
twelve hues to twelve series communicates nothing; give the two or three series
that matter a color and let the rest be neutral. The full 64-entry classic
palette exists for compatibility, not as a design recommendation — it is listed
in `reference.md` so you can recognize it, not so you can use all of it.

**Normalize axes so colors mean the same thing everywhere.** Compare CPU by
percentage, not raw cores: at 100% the viewer can trust every core is busy
without knowing how many there are. Split a dashboard's panels when magnitudes
differ so an aggregate doesn't drown the signal.

---

## 4. Units and number formatting

Set **Unit** as a standard option and Grafana scales automatically: 0.14kW and
3000kW render as 140W and 3MW. If you don't want that, control it with a custom
unit.

Custom unit syntax: `suffix:<s>`, `prefix:<p>`, `time:<moment format>`,
`si:<scale><unit>`, `count:<unit>`, `currency:<unit>` (abbreviated, `$501K`),
`currency:financial:<unit>` (full value, `500,555`; `:suffix` trails the symbol).
Full table in `reference.md` §6.

Other standard options that change how numbers read:

- **Min / Max** — used for percentage thresholds and for gauge ranges. Leave
  empty to auto-calculate. **Field min/max** switches from dataset-wide to
  per-field.
- **Decimals** — empty means Grafana truncates by magnitude (1.1234 → 1.12,
  100.456 → 100). Set to **String** unit to show every decimal.
- **Display name** — supports `${__field.name}`, `${__field.displayName}`,
  `${__field.labels}`, `${__field.labels.X}`, `${__field.labels.__values}`.
- **No value** — what to render when empty or null. Default is `-`. Set it; an
  empty tile and a zero tile must not look the same.

Date & time units expect **milliseconds** since epoch. Seconds-since-epoch data
silently renders as January 1970 — multiply by 1000 in a transformation first.

For the control room's own numbers: cost is `currency:financial:$` when exact
(spend today) and `currency:$` when abbreviated (month-to-date); token counts are
`short`; elapsed is `s` (seconds) or `dtdurations`; percentages are `percent`
with Min 0 / Max 100 so percentage thresholds mean what they say.

---

## 5. The sparkline-in-stat pattern

A graph sparkline is a small time-series graph drawn *in the background* of a
stat value. It exists only in the stat panel
(`.../visualizations/stat/index.md`).

To build one:

1. **Value options → Show**: `Calculate` (one value per series, via a reducer —
   Last, Mean, Max…) or `All values` (one tile per row, with a row limit).
2. **Calculation**: the reducer. `Last *` for "right now", `Mean` for
   "typically".
3. **Graph mode**: `Area`. This **requires the query to return a time column**.
   `None` hides it.
4. **Color mode**: `Value` (color the number and the sparkline area),
   `Background Gradient`, `Background Solid`, or `None`.
5. **Text mode**: `Auto` / `Value` / `Value and name` / `Name` / `None`. When the
   value doesn't matter and the color does, use `Name` — the value still drives
   the color and shows in the tooltip.
6. **Show percent change**: off by default; only when Show = `Calculate`. **Use
   `Inverted` for metrics where up is bad** — error rate, cost, latency.

Remaining options (Orientation, Wide layout, Text alignment, Text size) are in
`reference.md` §7.

The sparkline auto-hides when the panel gets too small. Give a stat with a
sparkline at least `h:4`.

Hand-rolling this outside Grafana: draw the sparkline as an SVG `<path>` at low
opacity (0.15-0.25) filling the tile's lower two-thirds, in the same color the
threshold assigned to the value. The number stays fully opaque on top.

---

## 6. Light theme token values (exact)

Sources: `packages/grafana-data/src/themes/{palette,createColors,createSpacing,createShape,createTypography,createShadows,createComponents}.ts`.
(These live in `grafana-data`, not `grafana-ui`; `grafana-ui/src/themes/getTheme.ts`
just calls `createTheme()` from `@grafana/data`.)

Light theme's `blackBase` is `36, 41, 46`.

### Background

| Token | Value | Use |
|---|---|---|
| `background.canvas` | `#fbfbfb` (gray100) | body / dashboard ground |
| `background.page` | `#ffffff` | page container |
| `background.primary` | `#ffffff` | panels, primary content panes |
| `background.secondary` | `#f4f5f5` (gray95) | cards, things that stand out on primary |
| `background.elevated` | `#ffffff` | popovers, menus |

### Border

| Token | Value | Use |
|---|---|---|
| `border.weak` | `rgba(36, 41, 46, 0.12)` | decoration, panel borders |
| `border.medium` | `rgba(36, 41, 46, 0.3)` | widget borders, inputs |
| `border.strong` | `rgba(36, 41, 46, 0.4)` | active / focused widget borders |

### Text

| Token | Value |
|---|---|
| `text.primary` | `rgba(36, 41, 46, 1)` |
| `text.secondary` | `rgba(36, 41, 46, 0.75)` |
| `text.disabled` | `rgba(36, 41, 46, 0.65)` |
| `text.link` | `#1f62e0` |
| `text.maxContrast` | `#000000` |

### State colors (light)

| Role | `.main` | `.text` | `.border` |
|---|---|---|---|
| `primary` / `accent` | `#3871dc` | `#1f62e0` | `#1f62e0` |
| `info` | `#3871dc` | `#1f62e0` | derived |
| `success` | `#1b855e` | `#0a764e` | derived |
| `warning` | `#ff9900` | `#B04E0C` | derived |
| `error` | `#e0226e` | `#cf0e5B` | `#cf0e5B` |
| `tertiary` | `#A24BC8` | `#7c2ea3` | derived |
| `secondary` | `#ececed` (gray90) | `text.primary` | `border.weak`; `.shade` `#e1e2e3` |

Derived members of a rich color (`createColors.ts`, `getRichColor`): `.background`
is `alpha(main, 0.15)`; `.shade` is `darken(main, tonalOffset)` in light mode;
`.contrastText` is chosen by contrast ratio; `.borderTransparent` is
`alpha(border, 0.25)`. Light `tonalOffset` = `0.2`, `contrastThreshold` = `3`,
`hoverFactor` = `0.03`.

### Action

`hover` `rgba(36,41,46,0.12)` · `selected` `rgba(36,41,46,0.08)` · `focus`
`rgba(36,41,46,0.12)` · `disabledBackground` `rgba(36,41,46,0.04)` ·
`disabledText` = `text.disabled` · `hoverOpacity` `0.08` · `disabledOpacity`
`0.38` · `selectedBorder` `#ff9900`.

### Spacing — `gridSize = 8`

| Token | px | Token | px |
|---|---|---|---|
| `x0` | 0 | `x2_5` | 20 |
| `x0_25` | 2 | `x3` | 24 |
| `x0_5` | 4 | `x4` | 32 |
| `x1` | 8 | `x5` | 40 |
| `x1_5` | 12 | `x6` | 48 |
| `x2` | 16 | `x8` | 64 |
| | | `x10` | 80 |

`theme.spacing(n)` = `n * 8px`; `theme.spacing(1, 2)` = `"8px 16px"`.

### Radii

`sm` `4px` (chips, tags, badges) · `md` = `default` `6px` (inputs, buttons,
cards, panels) · `lg` `10px` (modals, containers, and Grafana's own Card) ·
`pill` `9999px` · `circle` `100%`.

### Typography

Family `'Inter', 'Helvetica', 'Arial', sans-serif`; mono `'Roboto Mono', monospace`.
Base `fontSize` 14, `htmlFontSize` 14. Weights: light 300, regular 400, medium
500, bold 500 (yes, bold is 500).

| Variant | px | line-height | weight | letter-spacing |
|---|---|---|---|---|
| `h1` | 28 | 32 (1.143) | 400 | `-0.00893em` |
| `h2` | 24 | 28 (1.167) | 400 | `0em` |
| `h3` | 22 | 24 (1.091) | 400 | `0em` |
| `h4` | 18 | 22 (1.222) | 400 | `0.01389em` |
| `h5` | 16 | 22 (1.375) | 400 | `0em` |
| `h6` | 14 | 22 (1.571) | 500 | `0.01071em` |
| `body` | 14 | 22 (1.571) | 400 | `0.01071em` |
| `bodySmall` | 12 | 18 (1.5) | 400 | `0.0125em` |
| `code` | 14 | 16 (1.143) | 400 | mono |

Every font size and line height is an even number — deliberately, to keep
baselines aligned. Keep that if you add sizes.

### Shadows (light)

`z1` `0px 1px 2px rgba(24, 26, 27, 0.2)` (on-page) · `z2` `0px 4px 8px rgba(24,
26, 27, 0.2)` (dropdowns, menus, tooltips) · `z3` `0px 13px 20px 1px rgba(24, 26,
27, 0.18)` (modals, drawers).

### Component tokens (`createComponents.ts`)

| Component | Token | Light value |
|---|---|---|
| panel | `padding` | `1` → `8px` |
| panel | `headerHeight` | `5` → `40px` |
| panel | `background` | `#ffffff` |
| panel | `borderColor` | `border.weak` |
| panel | `boxShadow` | `none` |
| dashboard | `background` | `#fbfbfb` (canvas) |
| dashboard | `padding` | `1` → `8px` |
| card | `background` | `#f4f5f5` (secondary) |
| card | `borderColor` | `transparent` |
| input | `background` | `#ffffff`; border `border.medium`, hover `border.strong` |
| height | `sm` / `md` / `lg` | `3`/`4`/`6` → `24px` / `32px` / `48px` |
| table | `rowHoverBackground` | `action.hover` |
| menu | radius `lg`, padding `0.5` → `4px` |

Grafana's own `Card` (`grafana-ui/src/components/Card/CardContainer.tsx`) uses
`padding: theme.spacing(2)` = 16px (or `spacing(1)` = 8px compact),
`borderRadius: theme.shape.radius.lg` = 10px, `1px solid` `components.card.borderColor`,
and `marginBottom: theme.spacing(1)` = 8px — a good default panel shell.

The full viz hue table (six hues × five shades) and the classic palette are in
`reference.md`.

---

## 7. Authoring rules

From `.../build-dashboards/best-practices/index.md`:

- **One question per panel.** If a graph needs a paragraph to explain, it is two
  panels. "Which servers are in trouble?" — then show only the troubled ones.
- **Reduce cognitive load.** Ask: can I tell what each graph represents without
  thinking? How long would a stranger take to find their way?
- **Pick a strategy and write it down.** USE (Utilization, Saturation, Errors)
  for hardware and resources — reports *causes*. RED (Rate, Errors, Duration) for
  services — reports *symptoms*, closer to user experience, and the right thing
  to alert on. Four Golden Signals = RED + Saturation.
- **Consistent time ranges.** Don't mix ranges across panels in one view; if you
  must compare windows, use a query time offset rather than a different panel
  range, so both series share one axis.
- **Refresh no faster than the data changes.** Hourly data does not need a 30s
  refresh.
- **Left and right Y axes** when two series have different units or magnitudes —
  otherwise split the panels.
- **Avoid stacking.** It is misleading and hides data. Turn it off unless you can
  say why.
- **Name dashboards meaningfully.** Prefix experiments `TEST:` / `TMP:` and
  delete them.
- **Don't copy dashboards to change one thing.** You lose upstream fixes. Link to
  the original and vary it with URL parameters or template variables. If you must
  copy, rename it and **do not copy the tags** — tags drive search and copied
  ones create false matches.
- **Cross-reference.** Dashboard links, panel links, data links, a dashboard-list
  panel, or a text panel with markdown. Browsing should be *directed*, not
  guessing.
- **Version-control the dashboard JSON.** Generate from a script (grafonnet,
  grafanalib) once you have more than a handful, so style is consistent by
  construction rather than by discipline.
- **Actively reduce sprawl.** Review periodically; delete what nobody opens.

Maturity ladder for reference: **low** = everyone edits, copies everywhere, no
version control, lots of searching. **medium** = template variables instead of
per-node dashboards, hierarchy with drill-downs, layout reflects service
hierarchy, normalized axes, meaningful color. **high** = scripted generation, no
browser editing, browsing is the exception, dashboards are reviewed and retired.

---

## 8. Checklist before you ship a panel

- [ ] The panel answers exactly one question, and the title states it
- [ ] Panel **description** filled in (it becomes the `i` tooltip)
- [ ] Panel type matches the question (§2), not habit
- [ ] Unit set; decimals deliberate; **No value** set to something other than a
      bare `-` if empty and zero must differ
- [ ] Min/Max set if anything uses percentage thresholds or a gauge arc
- [ ] Color scheme is **From thresholds (by value)** for status, or **Classic
      palette (by series name)** for categorical — never plain Classic
- [ ] At most four threshold steps, in base/warn/critical/unknown semantics
- [ ] Stacking off unless justified
- [ ] Grid width is a divisor of 24; height ≥ 3 cells (90px), ≥ 4 for a sparkline
      stat
- [ ] Colors, spacing, radii and type come from §6 tokens, not from hand-picked
      hexes
- [ ] The time range matches the other panels in the row

---

## Sources

All paths are relative to the root of `github.com/grafana/grafana`. In a sparse
checkout, docs and theme sources under `docs/sources/` and
`packages/grafana-data/` may exist in the git objects but not in the working
tree — read those with `git show HEAD:<path>`.

- `public/app/core/constants.ts` — grid constants
- `packages/grafana-data/src/themes/palette.ts` — raw palette
- `packages/grafana-data/src/themes/createColors.ts` — `LightColors`, rich-color derivation
- `packages/grafana-data/src/themes/createSpacing.ts`, `createShape.ts`, `createTypography.ts`, `createShadows.ts`, `createComponents.ts`, `createVisualizationColors.ts`
- `packages/grafana-ui/src/themes/getTheme.ts`, `packages/grafana-ui/src/components/Card/CardContainer.tsx`
- `contribute/style-guides/themes.md` — `useStyles2` / `useTheme2` usage
- `docs/sources/visualizations/dashboards/build-dashboards/best-practices/index.md`
- `docs/sources/visualizations/dashboards/build-dashboards/create-dashboard/dashboard-groupings.md`
- `docs/sources/visualizations/panels-visualizations/configure-thresholds/index.md`
- `docs/sources/visualizations/panels-visualizations/configure-standard-options/index.md`
- `docs/sources/visualizations/panels-visualizations/visualizations/{stat,gauge,bar-gauge,time-series,table,text}/index.md`
