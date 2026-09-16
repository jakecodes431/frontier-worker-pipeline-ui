# grafana-dashboards — reference tables

Companion to `SKILL.md`. All values copied from `github.com/grafana/grafana`
(read paths with `git show HEAD:<path>` where a sparse checkout leaves the
working tree empty).

---

## 1. Visualization hues — light theme

`packages/grafana-data/src/themes/createVisualizationColors.ts`, `getLightHues()`.
The shade marked `primary` is what the bare name resolves to.

| Hue | super-light | light | **primary** | semi-dark | dark |
|---|---|---|---|---|---|
| red | `#FF7383` | `#F2495C` | **`#E02F44`** | `#C4162A` | `#AD0317` |
| orange | `#FFB357` | `#FF9830` | **`#FF780A`** | `#FA6400` | `#E55400` |
| yellow | `#FFEE52` | `#FADE2A` | **`#F2CC0C`** | `#E0B400` | `#CC9D00` |
| green | `#96D98D` | `#73BF69` | **`#56A64B`** | `#37872D` | `#19730E` |
| blue | `#8AB8FF` | `#5794F2` | **`#3274D9`** | `#1F60C4` | `#1250B0` |
| purple | `#CA95E5` | `#B877D9` | **`#A352CC`** | `#8F3BB8` | `#7C2EA3` |

Special names resolved by `getColorByName`: `transparent` →
`rgba(255, 255, 255, 0)` in light mode, `panel-bg` → `colors.background.primary`,
`text` → `colors.text.primary`.

**Recommended subset for operator UIs.** Use these six and stop:

| Purpose | Color |
|---|---|
| good / base | `#56A64B` green |
| warning | `#FF780A` orange |
| critical | `#E02F44` red |
| informational series | `#3274D9` blue |
| secondary series | `#A352CC` purple |
| neutral / no data | `rgba(36, 41, 46, 0.65)` (`text.disabled`) |

---

## 2. Classic palette (order-assigned)

`getClassicPalette()` in the same file. Listed for recognition, not as a design
recommendation — see §3 of `SKILL.md` on avoiding rainbows. The first six are
what most dashboards actually show.

```
green, semi-dark-yellow, blue, orange, red, purple,
dark-green, dark-yellow, dark-blue, dark-orange, dark-red, dark-purple,
super-light-green, super-light-yellow, super-light-blue,
super-light-orange, super-light-red, super-light-purple,
#447EBC #C15C17 #890F02 #0A437C #6D1F62 #584477
#B7DBAB #F4D598 #70DBED #F9BA8F #F29191 #82B5D8 #E5A8E2 #AEA2E0
#629E51 #E5AC0E #64B0C8 #E0752D #BF1B00 #0A50A1 #962D82 #614D93
#9AC48A #F2C96D #65C5DB #F9934E #EA6460 #5195CE #D683CE #806EB7
#3F6833 #967302 #2F575E #99440A #58140C #052B51 #511749 #3F2B5B
#E0F9D7 #FCEACA #CFFAFF #F9E2D2 #FCE2DE #BADFF4 #F9D9F9 #DEDAF7
```

Colors follow **field order**, so a query returning fields in a different order
recolors the chart. Prefer **Classic palette (by series name)** whenever the set
of series can change.

---

## 3. Grey ramp

`packages/grafana-data/src/themes/palette.ts`. Light theme uses the top of this
ramp (`gray85`–`gray100`); dark theme uses the bottom.

| | | | |
|---|---|---|---|
| `gray05` `#111217` | `gray10` `#181b1f` | `gray15` `#22252b` | `gray20` `#2c2f35` |
| `gray25` `#383b42` | `gray30` `#44474e` | `gray35` `#51555b` | `gray40` `#5f6268` |
| `gray45` `#6e7177` | `gray50` `#7d8085` | `gray55` `#8c8f94` | `gray60` `#9c9fa3` |
| `gray65` `#ababaf` | `gray70` `#babcbe` | `gray75` `#c8cacc` | `gray80` `#d6d7d9` |
| `gray85` `#e1e2e3` | `gray90` `#ececed` | `gray95` `#f4f5f5` | `gray100` `#fbfbfb` |

`white` `#ffffff`, `black` `#000000`.

Named brand colors, light theme:
`blueLightMain` `#3871dc` · `blueLightText` `#1f62e0` ·
`redLightMain` `#e0226e` · `redLightText` `#cf0e5B` ·
`greenLightMain` `#1b855e` · `greenLightText` `#0a764e` ·
`orangeLightMain` `#ff9900` · `orangeLightText` `#B04E0C` ·
`purpleLightMain` `#A24BC8` · `purpleLightText` `#7c2ea3`.

Dark equivalents (for a future dark mode):
`blueDarkMain` `#3d71d9` / `blueDarkText` `#6e9fff` ·
`redDarkMain` `#d10e5c` / `redDarkText` `#ff5286` ·
`greenDarkMain` `#1a7f4b` / `greenDarkText` `#6ccf8e` ·
`orangeDarkMain` `#ff9900` / `orangeDarkText` `#fbad37` ·
`purpleDarkMain` `#C27AFF` / `purpleDarkText` `#D4A0FF`.
Dark theme's `whiteBase` is `204, 204, 220`; backgrounds are
canvas `gray05`, page/primary `gray10`, secondary/elevated `gray15`;
borders `rgba(whiteBase, 0.12 / 0.2 / 0.30)`.

---

## 4. Badge colors

`getBadgeColorToken()` in `createComponents.ts`. For a source color `C` in light
mode: background `hsl(from C h s l / 0.15)`, border `hsl(from C h s l / 0.25)`,
text `hsl(from C h s calc(l - 25))`.

| Badge | Light source |
|---|---|
| red | `#E02F44` |
| orange | `#FF780A` |
| green | `#56A64B` |
| blue | `#3274D9` |
| purple | `#A352CC` |
| darkgrey | `#a9a9a9` |

(Dark mode shifts text by `+15` lightness and uses the `light-*` shades as
sources.)

---

## 5. Threshold behaviour per visualization

`docs/sources/visualizations/panels-visualizations/configure-thresholds/index.md`.

Thresholds are supported in: bar chart, bar gauge, candlestick, canvas, gauge,
geomap, histogram, stat, state timeline, status history, table, time series,
trend.

Defaults: `Base = green`, `80 = red`, mode `Absolute`, **Show thresholds** off on
visualizations that support that option.

**Show thresholds** (bar chart, candlestick, time series, trend only):

| Option | Renders as |
|---|---|
| Off | nothing |
| As lines | a horizontal line at the threshold value |
| As lines (dashed) | same, dashed |
| As filled regions | a tinted band from the threshold outward |
| As filled regions and lines | both |
| As filled regions and lines (dashed) | both, dashed line |

What a threshold colors, by panel:

| Panel | Colored |
|---|---|
| stat | value text, and/or background (gradient or solid), and the sparkline area |
| gauge | gauge arc and threshold markers |
| bar gauge | bar fill |
| time series | line color, grid lines, threshold lines, filled regions |
| state timeline | region colors |
| table | cell text or cell background |
| geomap | markers |

---

## 6. Standard options, full list

`docs/sources/visualizations/panels-visualizations/configure-standard-options/index.md`.
Applied to all fields unless narrowed by an override.

| Option | Notes |
|---|---|
| **Unit** | Drill-down list, plus custom syntax (below). Applied to every field except time. |
| **Min** | Minimum for percentage-threshold math. Empty = auto. |
| **Max** | Maximum for percentage-threshold math. Empty = auto. |
| **Field min/max** | Compute min/max per field instead of across all series. |
| **Decimals** | Empty = Grafana truncates by magnitude. `String` unit shows all. |
| **Display name** | Supports field/label expressions; empty result falls back to default. |
| **Color scheme** | See table below. |
| **No value** | Rendered when empty/null. Default `-`. |

### Custom unit syntax

| Syntax | Meaning |
|---|---|
| `suffix:<suffix>` | unit after the value |
| `prefix:<prefix>` | unit before the value |
| `time:<format>` | moment.js date format |
| `si:<base scale><unit>` | SI unit including the source data's scale, e.g. `si: mF` |
| `count:<unit>` | custom count unit |
| `currency:<unit>` | custom currency, abbreviated with K/M/B/T |
| `currency:financial:<unit>` | full numeric value, no abbreviation; `:suffix` trails the symbol |

A pasted emoji is also accepted as a custom unit. Date & time units require
**milliseconds** since epoch.

### Color schemes

| Scheme | Assignment |
|---|---|
| Single color | one fixed color |
| Shades of a color | shades of one hue |
| From thresholds (by value) | matching threshold's color; some panels let you pick Last / Min / Max |
| Classic palette | by field **order** — shifts when order changes |
| Classic palette (by series name) | by series **name** — stable |
| Multiple continuous colors (by value) | Green-Yellow-Red, Red-Yellow-Green, Blue-Yellow-Red, Yellow-Red, Blue-Purple, Yellow-Blue |
| Single continuous color (by value) | Blues, Reds, Greens, Purples |

Clicking a legend's color swatch creates a per-series override automatically.

### Display-name expressions

For a field named `Temp` with labels `{Loc="PBI", Sensor="3"}`:

| Expression | Renders |
|---|---|
| `${__field.displayName}` | `Temp {Loc="PBI", Sensor="3"}` |
| `${__field.name}` | `Temp` |
| `${__field.labels}` | `Loc="PBI", Sensor="3"` |
| `${__field.labels.Loc}` | `PBI` |
| `${__field.labels.__values}` | `PBI, 3` |

---

## 7. Stat panel options, full list

`docs/sources/visualizations/panels-visualizations/visualizations/stat/index.md`.

**Value options**

| Option | Values |
|---|---|
| Show | `Calculate` (one value per column/series) · `All values` (one tile per row, with a row limit) |
| Calculation | reducer used when Show = Calculate: Last, Last *, Mean, Max, Min, Total, Count, … |
| Fields | which fields feed the tiles |

**Stat styles**

| Option | Values |
|---|---|
| Orientation | `Auto` · `Horizontal` (left→right) · `Vertical` (top→bottom) |
| Text mode | `Auto` · `Value` · `Value and name` · `Name` · `None` |
| Wide layout | On/Off. Only when Text mode = `Value and name`. On = value right of the name when wide enough; Off = value under the name. |
| Color mode | `None` · `Value` · `Background Gradient` · `Background Solid` |
| Graph mode | `None` · `Area` (the sparkline; requires a time column; auto-hides when the panel is small) |
| Text alignment | `Auto` (centered for one value, left for many) · `Center` |
| Show percent change | off by default; only when Show = `Calculate` |
| Percent change color mode | `Standard` (green up / red down) · `Inverted` · `Same as Value` |

**Text size** — explicit numeric sizes for Title, Value, and Percent change.

Stat also takes Standard options, Data links and actions, Value mappings, and
Thresholds.

---

## 8. Gauge and bar gauge data shapes

`.../visualizations/gauge/index.md`, `.../visualizations/bar-gauge/index.md`.

- Both need at least one numeric field. Text fields become labels; they are
  optional.
- With multiple fields in one row, you get one gauge per field, and min/max are
  inferred from the **whole dataset** — including values not currently displayed.
- With multiple rows, the default (`Show: Calculate`) displays only the last row,
  but still derives min/max from the whole dataset. Switch to `Show: All values`
  for one gauge per cell; each label is `<text column> <value column name>`.
- You can carry min and max **in the data** as extra columns, then hide them via
  **Value options → Fields**. The range still applies.

---

## 9. Table specifics

`.../visualizations/table/index.md`.

- Any column-row structure works, but the structure must be **complete**: one
  missing cell and the table renders nothing at all. Fix with a transformation or
  by querying only the columns you need.
- Cell types can render colored text, colored backgrounds, gauges, sparklines,
  JSON, images, and data links. Sparkline and JSON cell types have their own data
  requirements.
- **Column filter** adds a funnel icon per column for ad-hoc value filtering.
- Tables support multiple datasets with a switcher.
- **Annotations and alerts are not supported** on tables.

---

## 10. Text panel options

`.../visualizations/text/index.md`.

| Option | Values |
|---|---|
| Mode | `Markdown` · `HTML` (sanitized unless `disable_sanitize_html`) · `Code` (read-only editor, variables expanded) |
| Content | the text; dashboard variables are interpolated |
| Language | Code mode only: JSON, YAML, XML, TypeScript, SQL, Go, Markdown, HTML, Plain text (default) |
| Show line numbers | Code mode only |
| Show mini map | Code mode only |

Embedding iframes requires `allow_embedding = true` in Grafana's config.

---

## 11. Observability strategies

`.../build-dashboards/best-practices/index.md`.

| Method | Signals | Best for | Reports |
|---|---|---|---|
| **USE** | Utilization, Saturation, Errors | hardware / infrastructure resources (CPU, memory, network devices) | **causes** |
| **RED** | Rate, Errors, Duration | services, microservices; per-component instrumentation | **symptoms** / user experience |
| **Four Golden Signals** | Latency, Traffic, Errors, Saturation | user-facing systems | both |

Alert on **symptoms**, so alert from RED dashboards. A well-designed RED
dashboard is a proxy for user experience.

Layout convention for a RED dashboard: request and error rate on the **left**,
latency duration on the **right**, one row per service, rows ordered to follow
the data flow.

---

## 12. Dashboard management maturity

| Level | Looks like |
|---|---|
| **Low** | Everyone can edit; copies everywhere with no reuse; one-off dashboards that never die; no version control; lots of searching; no alerts pointing anywhere. |
| **Medium** | Template variables instead of per-node dashboards (make the *data source* a variable too); dashboards follow a written observability strategy; hierarchical with drill-downs; layout mirrors service hierarchy; like compared to like; normalized axes; meaningful color; directed browsing via links; dashboard JSON in version control. |
| **High** | Sprawl actively reduced and dashboards retired; only approved dashboards on the master list; usage tracked; consistency by design; dashboards generated by scripting libraries (grafonnet / grafanalib); no editing in the browser — viewers change variables; browsing is the exception; experimentation happens on a separate instance. |

---

## 13. Theme access in React (if the UI adopts Grafana's pattern)

`contribute/style-guides/themes.md`.

```tsx
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2, useTheme2 } from '@grafana/ui';
import { css } from '@emotion/css';

const getStyles = (theme: GrafanaTheme2) =>
  css({ padding: theme.spacing(1, 2) });

function Panel() {
  const styles = useStyles2(getStyles);   // memoized, theme-aware
  const theme = useTheme2();              // raw token object
}
```

The control room UI is vanilla, so the practical translation is CSS custom
properties named after the tokens (`--bg-canvas`, `--border-weak`,
`--text-secondary`, `--space-2`, `--radius-lg`) set once on `:root` from the
values in `SKILL.md` §6, and a dark block that swaps only those variables.
