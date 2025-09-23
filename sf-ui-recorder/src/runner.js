const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const minimist = require('minimist');
const Ajv = require('ajv');
const { getOrgInfo, buildFrontdoorUrl, DEFAULT_RET_URL } = require('./sf');
const { resolveHandle } = require('./selectors');

const DEFAULT_TIMEOUT = 20000;
const DEFAULT_WAIT_SHORT = 300;

function loadJson(filePath) {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Steps file not found: ${absPath}`);
  }
  return JSON.parse(fs.readFileSync(absPath, 'utf8'));
}

function loadSchema() {
  const schemaPath = path.resolve(__dirname, '../schema/steps.schema.json');
  return JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
}

function parsePlan(plan) {
  if (Array.isArray(plan)) {
    return { steps: plan, root: plan };
  }
  if (plan && typeof plan === 'object' && Array.isArray(plan.steps)) {
    return { steps: plan.steps, root: plan };
  }
  throw new Error('Invalid steps root: expected array or {steps:[...]}.');
}

function createArtifactsDir(dir) {
  const abs = path.resolve(dir);
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}

async function waitForLexIdle(page, { timeout = 30000 } = {}) {
  if (!page) {
    return;
  }
  try {
    await page.waitForFunction(
      () => {
        const spinner = document.querySelector('.slds-spinner, [data-aura-class="forceLoadingSpinner"]');
        const modal = document.querySelector('.slds-modal.slds-fade-in-open, .forceModal');
        return !spinner && !modal;
      },
      { timeout }
    );
    if (typeof page.waitForTimeout === 'function') {
      await page.waitForTimeout(300);
    }
  } catch (err) {
    // Allow continuation when Lightning keeps spinners around.
  }
}

async function sleep(page, ms) {
  if (ms <= 0) {
    return;
  }
  if (page && typeof page.waitForTimeout === 'function') {
    await page.waitForTimeout(ms);
  } else {
    await new Promise(resolve => setTimeout(resolve, ms));
  }
}

async function snap(page, filePath) {
  if (!page) {
    return;
  }
  try {
    await page.screenshot({ path: filePath, fullPage: false });
  } catch (err) {
    console.warn(`Unable to capture screenshot (${path.basename(filePath)}): ${err.message}`);
  }
}

async function snapArea(page, handle, filePath) {
  if (!page || !handle || !filePath) {
    return;
  }
  try {
    const box = await handle.boundingBox();
    if (!box) {
      return;
    }
    const pad = 8;
    let viewport = page.viewport && page.viewport();
    if (!viewport || !viewport.width || !viewport.height) {
      try {
        viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
      } catch (err) {
        viewport = {};
      }
    }
    const clip = {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: box.width + pad * 2,
      height: box.height + pad * 2
    };
    if (viewport && viewport.width) {
      clip.width = Math.min(clip.width, Math.max(1, viewport.width - clip.x));
    }
    if (viewport && viewport.height) {
      clip.height = Math.min(clip.height, Math.max(1, viewport.height - clip.y));
    }
    clip.width = Math.max(1, clip.width);
    clip.height = Math.max(1, clip.height);
    await page.screenshot({ path: filePath, clip });
  } catch (err) {
    console.warn(`Unable to capture area screenshot (${path.basename(filePath)}): ${err.message}`);
  }
}

async function saveDom(page, filePath) {
  if (!page) {
    return;
  }
  try {
    const html = await page.content();
    await fs.promises.writeFile(filePath, html, 'utf8');
  } catch (err) {
    console.warn(`Unable to capture DOM snapshot (${path.basename(filePath)}): ${err.message}`);
  }
}

async function robustClick(page, handle) {
  if (!handle) {
    throw new Error('Missing element handle for click.');
  }
  await page.evaluate(el => {
    if (el && el.scrollIntoView) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    }
  }, handle);

  try {
    await handle.click({ delay: 10 });
    return;
  } catch (primary) {
    try {
      await page.evaluate(el => {
        if (el && typeof el.click === 'function') {
          el.click();
        }
      }, handle);
      await sleep(page, 150);
      await handle.click({ delay: 10 });
    } catch (secondary) {
      throw primary;
    }
  }
}

async function applyWait(page, step) {
  if (!step) {
    return;
  }
  if (step.action === 'wait' && typeof step.ms === 'number') {
    await sleep(page, step.ms);
    return;
  }
  const waitFor = step.waitFor || {};

  if (typeof waitFor.ms === 'number') {
    await sleep(page, waitFor.ms);
    return;
  }

  if (waitFor.selector) {
    try {
      const handle = await resolveHandle(page, waitFor.selector, { timeout: DEFAULT_TIMEOUT });
      if (handle) {
        await handle.dispose();
      }
    } catch (err) {
      console.warn(`waitFor selector not resolved: ${err.message}`);
    }
  }

  switch (waitFor.type) {
    case 'networkidle':
      await waitForLexIdle(page);
      break;
    case 'dom':
      try {
        await page.waitForFunction(() => document.readyState === 'complete', { timeout: DEFAULT_TIMEOUT });
      } catch (err) {
        // continue when DOM stays busy
      }
      await sleep(page, 200);
      break;
    case 'short':
    default:
      await sleep(page, DEFAULT_WAIT_SHORT);
      break;
  }
}

async function performClick(page, step, areaPath) {
  if (!step.selector) {
    throw new Error('Click step missing selector.');
  }
  const handle = await resolveHandle(page, step.selector, { timeout: DEFAULT_TIMEOUT });
  try {
    if (areaPath) {
      await snapArea(page, handle, areaPath);
    }
    await robustClick(page, handle);
  } finally {
    try {
      await handle.dispose();
    } catch (err) {
      // ignore disposal issues
    }
  }
  await applyWait(page, step);
}

async function performType(page, step, areaPath) {
  if (!step.selector) {
    throw new Error('Type step missing selector.');
  }
  const handle = await resolveHandle(page, step.selector, { timeout: DEFAULT_TIMEOUT });
  const value = step.value != null ? String(step.value) : '';
  const delay = typeof step.delay === 'number' ? step.delay : 30;
  try {
    if (areaPath) {
      await snapArea(page, handle, areaPath);
    }
    const result = await handle.evaluate((el, inputValue) => {
      if (el instanceof HTMLSelectElement) {
        const options = Array.from(el.options);
        const match = options.find(opt => opt.value === inputValue || opt.text === inputValue);
        el.value = match ? match.value : inputValue;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { typed: false };
      }
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        el.focus();
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return { typed: true };
      }
      if (el && el.isContentEditable) {
        el.focus();
        el.textContent = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return { typed: true };
      }
      return { typed: false };
    }, value);

    if (result && result.typed) {
      await handle.type(value, { delay });
    }

    await handle.evaluate(el => {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  } finally {
    try {
      await handle.dispose();
    } catch (err) {
      // ignore disposal issues
    }
  }

  await applyWait(page, step);
}

async function performWait(page, step) {
  await applyWait(page, step);
}

async function run() {
  const argv = minimist(process.argv.slice(2), {
    string: ['org', 'steps', 'ret', 'artifacts', 'shots'],
    boolean: ['headful', 'no-validate'],
    alias: { org: 'o', steps: 's', ret: 'r' }
  });

  const orgAlias = argv.org;
  const stepsPath = argv.steps;
  if (!orgAlias || !stepsPath) {
    console.error('Usage: node src/runner.js --org <alias> --steps <file> [--ret <retURL>] [--artifacts <dir>] [--shots none|step|verbose] [--headful] [--no-validate]');
    process.exit(1);
  }

  const shotsModeInput = (argv.shots || 'step').toLowerCase();
  const shotsMode = ['none', 'step', 'verbose'].includes(shotsModeInput) ? shotsModeInput : 'step';

  const schema = loadSchema();
  const planRaw = loadJson(stepsPath);
  const { steps, root } = parsePlan(planRaw);
  if (!Array.isArray(steps)) {
    throw new Error('Plan does not contain a steps array.');
  }

  if (!argv['no-validate']) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    if (!validate(root)) {
      console.error('Steps file failed validation:', validate.errors);
      process.exit(1);
    }
  }

  const retURL = argv.ret || DEFAULT_RET_URL;
  const { instanceUrl, accessToken } = getOrgInfo(orgAlias);
  const frontdoorUrl = buildFrontdoorUrl(instanceUrl, accessToken, retURL);

  const timestamp = new Date().toISOString().replace(/[:]/g, '-');
  const defaultRunId = `${timestamp}-${Math.random().toString(36).slice(-5)}`;
  const artifactsDir = createArtifactsDir(argv.artifacts || path.join('runs', defaultRunId));
  console.log(`Artifacts directory: ${artifactsDir}`);

  const browser = await puppeteer.launch({
    headless: !argv.headful,
    defaultViewport: null,
    args: ['--disable-infobars']
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(DEFAULT_TIMEOUT);

  console.log(`Opening ${frontdoorUrl}`);
  await page.goto(frontdoorUrl, { waitUntil: 'networkidle2' });
  await waitForLexIdle(page);

  let failure = null;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const label = `step-${index + 1}`;
    console.log(`Executing step ${index + 1}/${steps.length}: ${step.action}`);

    try {
      const areaPath = path.join(artifactsDir, `${label}-area.png`);
      if (shotsMode !== 'none') {
        await snap(page, path.join(artifactsDir, `${label}-pre.png`));
      }

      switch (step.action) {
        case 'click':
          await performClick(page, step, areaPath);
          break;
        case 'type':
          await performType(page, step, areaPath);
          break;
        case 'wait':
          await performWait(page, step);
          break;
        default:
          throw new Error(`Unsupported action: ${step.action}`);
      }

      if (shotsMode !== 'none') {
        await snap(page, path.join(artifactsDir, `${label}-post.png`));
      }
    } catch (err) {
      const errorShot = path.join(artifactsDir, `${label}-error.png`);
      await snap(page, errorShot);
      if (shotsMode === 'verbose') {
        await saveDom(page, path.join(artifactsDir, `${label}-dom.html`));
      }
      const relativeError = path.relative(process.cwd(), errorShot);
      failure = new Error(`${err.message || err} (see ${relativeError})`);
      failure.stack = err.stack;
      console.error(`Step ${index + 1} failed: ${failure.message}`);
      break;
    }
  }

  if (!failure) {
    console.log('Run complete.');
  }

  await browser.close();

  if (failure) {
    throw failure;
  }
}

run()
  .then(() => {
    // success
  })
  .catch(err => {
    console.error('Runner failed:', err.message);
    process.exit(1);
  });
