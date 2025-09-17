# SF UI Recorder

Minimal recorder/replayer for Salesforce Lightning actions using Puppeteer and local Salesforce CLI auth.

## Prerequisites

- Node.js 18 or newer
- [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) installed and on your PATH
- At least one org authenticated locally via `sf login web`

## Install dependencies

```bash
npm install
```

## Record a flow

```bash
node src/recorder.js --org <alias> --out steps/mi-flujo.json --ret /lightning/o/Case/list?filterName=Recent
```

This opens the specified org in a non-headless browser and captures clicks and form changes into `steps/mi-flujo.json`.

## Replay a flow

```bash
node src/runner.js --org <alias> --steps steps/mi-flujo.json
```

This launches headless (using Puppeteer's modern `headless: "new"` mode) by default and runs the recorded steps against the chosen org. Pass `--headful` to watch the playback. Use `--timeout 20000` (milliseconds) to extend selector resolution for slower orgs, and `--debug` to emit selector diagnostics and a screenshot (`debug-step-<n>.png`) if a step fails.

## Notes

- The recorder attempts to use labels, text, and `data-testid` attributes for stable selectors before falling back to CSS paths.
- Ensure Lightning pages finish loading before interacting so that selectors remain consistent.
