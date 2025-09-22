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

## Replaying a flow

```bash
node src/runner.js --org <alias> --steps steps/mi-flujo.json
```

The runner executes headlessly by default. Pass `--headful` if you want to observe execution, `--timeout 20000` (milliseconds) to extend selector resolution when Lightning loads slowly, and `--no-validate` to skip AJV validation for quick experiments. Failures always emit a `debug-step-<n>.png` screenshot; add `--debug` to capture additional selector diagnostics alongside the image.

## Notes

- Ensure you have already authenticated the target alias with `sf login web` outside of this tool.
- Step files are stored under `steps/`; this directory is ignored by Git except for the provided example.
- Additional documentation and schema details live in `sf-ui-recorder/README.md`.
- Text selectors support `match: "equals" | "contains" | "regex"` to address Lightning labels that vary between orgs.
- Navigation clicks scroll into view, retry with a DOM `click()` if Puppeteer complains, and wait for the page to reach a network-idle state before the next step.
- Failures always emit a `debug-step-<n>.png` screenshot; add `--debug` to capture extra selector diagnostics.
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
