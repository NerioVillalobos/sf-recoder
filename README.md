# SF Recorder

Minimal Salesforce Lightning recorder/replayer that uses existing Salesforce CLI auth.

## Getting started

1. Install dependencies (workspace aware):
   ```bash
   PUPPETEER_SKIP_DOWNLOAD=1 npm install
   ```
   This installs the nested `sf-ui-recorder` package. If you prefer, run the same command inside `sf-ui-recorder/` instead of using workspaces.
2. Return to the repo root to run the tools.

## Recording a flow

From the repository root:

```bash
node src/recorder.js --org <alias> --out steps/mi-flujo.json --ret /lightning/o/Case/list?filterName=Recent
```

This command proxies to the recorder inside `sf-ui-recorder/src/recorder.js`, launches a non-headless browser, and writes steps
to the given JSON file (relative paths resolve from the repo root). For Field Service Settings flows you can land directly on the
admin page with:

```bash
node src/recorder.js --org <alias> --out steps/mi-flujo.json --ret /lightning/n/FSL_Field_Service_Settings
```

### Recording tips

- Ignore App Launcher noise: clicks on the waffle button or the "Search apps and items" input are intentionally skipped. Land directly on the target page with `start.retURL` instead of relying on the App Launcher flow.
- When a click hits a small `+` expander in the left nav, the recorder walks up to the parent item and captures the section label (for example `{ "type": "text", "text": "Optimization" }`).
- Lightning status summaries such as `"4 statuses selected"` are rewritten to a contextual XPath pointing at the combobox button inside the correct card/field (for example the Resource Schedule Optimization → Pin Criteria selector shown below).
- Prefer stable tabs or clearly labelled buttons. The recorder falls back to XPath only when it cannot find a role, label, or short visible text.

## MVP with screenshots

Capture cropped previews while recording and organize replay artifacts per run:

```bash
node src/recorder.js --org <alias> --out steps/flow.json --ret /lightning/page/home --snap-area
```

```bash
node src/runner.js --org <alias> --steps steps/flow.json --ret /lightning/page/home --shots step --artifacts runs/demo-1
```

- `--snap-area` adds a `shots/` folder next to the output JSON and annotates each click with `note: "areaShot: shots/<n>-area.png"`.
- The runner ignores any `start.retURL` stored in the file—pass `--ret` (default `/lightning/page/home`) for the landing path.
- Screenshot modes: `--shots none` disables pre/post captures, `--shots step` (default) records pre/post plus error images, and `--shots verbose` additionally saves HTML snapshots on failure.
- Artifacts live under `runs/<timestamp>-<id>/`, keeping every pre/post/error asset grouped by run id.
- Lightning waits rely on spinner/modal detection, and every click scrolls into view before attempting a Puppeteer click with a DOM fallback retry.

## Replaying a flow

```bash
node src/runner.js --org <alias> --steps steps/mi-flujo.json
```

The runner executes headlessly by default. Pass `--headful` if you want to observe execution, `--ret <path>` to override the landing page, `--shots none|step|verbose` to control pre/post/error captures, and `--artifacts <dir>` to reuse a specific folder. Use `--no-validate` to skip AJV validation for quick experiments. Failures always emit a `step-<n>-error.png` screenshot alongside the optional HTML snapshot when `--shots verbose` is enabled.

## Scan mode (UI map)

Generate a JSON map of actionable UI controls on the current page without recording clicks:

```bash
node src/recorder.js --org <alias> --ret /lightning/page/home --scan --out maps/fsl-settings.map.json
```

The output lives under `maps/` by default and follows this shape:

```json
{
  "url": "https://example.lightning.force.com/lightning/page/home",
  "timestamp": "2024-01-01T12:00:00.000Z",
  "frameCount": 2,
  "frames": [
    {
      "frameUrl": "https://example.lightning.force.com/lightning/page/home",
      "sameOrigin": true,
      "elements": [
        {
          "role": "button",
          "tag": "button",
          "name": "Save",
          "visible": true,
          "region": "main",
          "bbox": { "x": 1024, "y": 540, "width": 90, "height": 32 },
          "candidates": {
            "roleName": { "role": "button", "name": "Save" },
            "text": "Save",
            "xpath": "/html/body/div[1]/div/button[3]"
          }
        }
      ]
    }
  ]
}
```

Notes:

- Same-origin iframes (for example Visualforce) are scanned; cross-origin frames are listed with `sameOrigin: false` and an empty `elements` array.
- Lightning shadow DOM (LWC) trees are traversed so controls rendered inside web components are included.
- Locator candidates are suggestions (role/name, data-testid, label, text, CSS, XPath) meant to speed up authoring — review them before use.
- Use the generated map to choose stable selectors for new steps or to inspect which regions of the page expose actionable elements.

## Notes

- Ensure you have already authenticated the target alias with `sf login web` outside of this tool.
- Step files are stored under `steps/`; this directory is ignored by Git except for the provided example.
- Additional documentation and schema details live in `sf-ui-recorder/README.md`.
- Text selectors support `match: "equals" | "contains" | "regex"` to address Lightning labels that vary between orgs.
- Navigation clicks scroll into view, retry with a DOM `click()` if Puppeteer complains, and wait for the page to reach a network-idle state before the next step.
- Failures always emit a `step-<n>-error.png` screenshot and, when `--shots verbose`, an accompanying `step-<n>-dom.html` dump fo
r debugging.
- The recorder and runner launch browsers at 1600×900 so Lightning stays in its desktop layout.

## Sample: Field Service Settings update

```json
{
  "version": 1,
  "start": { "retURL": "/lightning/n/FSL_Field_Service_Settings" },
  "steps": [
    { "action": "wait", "waitFor": { "type": "networkidle" } },
    { "action": "click", "selector": { "type": "text", "text": "Optimization" }, "waitFor": { "type": "short" } },
    { "action": "click", "selector": { "type": "text", "text": "Logic" }, "waitFor": { "type": "networkidle" } },
    {
      "action": "click",
      "selector": {
        "type": "xpath",
        "value": "//*[normalize-space()='Resource Schedule Optimization' or normalize-space()='Optimización de la programación de recursos']/ancestor::*[contains(@class,'slds-card') or contains(@class,'slds-section')][1]//*[normalize-space()='Pin Criteria' or normalize-space()='Criterios de fijación']/ancestor::*[self::div or self::label][1]//button[contains(@aria-haspopup,'listbox') or @role='combobox' or contains(normalize-space(.),'statuses selected')]"
      },
      "waitFor": { "type": "short" }
    },
    { "action": "click", "selector": { "type": "text", "text": "Mal Dirección TECO" }, "waitFor": { "type": "short" } },
    { "action": "click", "selector": { "type": "text", "text": "Save" }, "waitFor": { "type": "networkidle" } }
  ]
}
```
