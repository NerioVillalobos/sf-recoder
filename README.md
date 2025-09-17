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
to the given JSON file (relative paths resolve from the repo root).

## Replaying a flow

```bash
node src/runner.js --org <alias> --steps steps/mi-flujo.json
```

The runner executes headlessly by default. Pass `--headful` if you want to observe execution.

## Notes

- Ensure you have already authenticated the target alias with `sf login web` outside of this tool.
- Step files are stored under `steps/`; this directory is ignored by Git except for the provided example.
- Additional documentation and schema details live in `sf-ui-recorder/README.md`.
