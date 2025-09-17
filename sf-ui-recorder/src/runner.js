const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const minimist = require('minimist');
const Ajv = require('ajv');
const { getOrgInfo, buildFrontdoorUrl, DEFAULT_RET_URL } = require('./sf');
const { resolveHandle } = require('./selectors');

function loadSchema() {
  const schemaPath = path.resolve(__dirname, '../schema/steps.schema.json');
  return JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
}

function loadSteps(filePath) {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Steps file not found: ${absPath}`);
  }
  const contents = fs.readFileSync(absPath, 'utf8');
  return JSON.parse(contents);
}

async function wait(page, ms) {
  if (ms <= 0) {
    return;
  }
  if (page && typeof page.waitForTimeout === 'function') {
    await page.waitForTimeout(ms);
  } else {
    await new Promise(resolve => setTimeout(resolve, ms));
  }
}

function waitDuration(waitFor) {
  if (!waitFor) {
    return 200;
  }
  if (typeof waitFor.ms === 'number') {
    return waitFor.ms;
  }
  switch (waitFor.type) {
    case 'long':
      return 3000;
    case 'medium':
      return 1500;
    case 'short':
    default:
      return 500;
  }
}

async function applyWait(page, waitFor) {
  const duration = waitDuration(waitFor);
  await wait(page, duration);
}

async function performClick(page, step) {
  const handle = await resolveHandle(page, step.selector);
  await handle.evaluate(el => {
    if (el.scrollIntoView) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    }
  });
  await handle.click({ delay: 50 });
  await applyWait(page, step.waitFor);
}

async function performType(page, step) {
  const handle = await resolveHandle(page, step.selector);
  const value = step.value || '';
  const delay = typeof step.delay === 'number' ? step.delay : 30;

  const result = await handle.evaluate((el, inputValue) => {
    if (el instanceof HTMLSelectElement) {
      const options = Array.from(el.options);
      const match = options.find(opt => opt.value === inputValue || opt.text === inputValue);
      if (match) {
        el.value = match.value;
      } else {
        el.value = inputValue;
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { typed: false };
    }

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.focus();
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return { typed: true };
    }

    if (el.isContentEditable) {
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

  await applyWait(page, step.waitFor);
}

async function performWait(page, step) {
  await applyWait(page, step.waitFor);
}

async function main() {
  const argv = minimist(process.argv.slice(2), {
    string: ['org', 'steps', 'ret'],
    boolean: ['headful'],
    alias: { org: 'o', steps: 's', ret: 'r', headful: 'H' }
  });

  const orgAlias = argv.org;
  const stepsPath = argv.steps;
  const retURL = argv.ret || DEFAULT_RET_URL;
  const headless = !argv.headful;

  if (!orgAlias || !stepsPath) {
    console.error('Usage: node src/runner.js --org <alias> --steps <file> [--ret <retURL>] [--headful]');
    process.exit(1);
  }

  const schema = loadSchema();
  const steps = loadSteps(stepsPath);

  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  if (!validate(steps)) {
    console.error('Steps file failed validation:', validate.errors);
    process.exit(1);
  }

  const { instanceUrl, accessToken } = getOrgInfo(orgAlias);
  const frontdoorUrl = buildFrontdoorUrl(instanceUrl, accessToken, retURL);

  const browser = await puppeteer.launch({
    headless,
    defaultViewport: null,
    args: headless ? ['--disable-infobars'] : ['--disable-infobars']
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(15000);

  console.log(`Opening ${frontdoorUrl}`);
  await page.goto(frontdoorUrl, { waitUntil: 'networkidle2' });
  await wait(page, 1000);

  for (const [index, step] of steps.entries()) {
    console.log(`Executing step ${index + 1}/${steps.length}: ${step.action}`);
    try {
      switch (step.action) {
        case 'click':
          await performClick(page, step);
          break;
        case 'type':
          await performType(page, step);
          break;
        case 'wait':
          await performWait(page, step);
          break;
        default:
          console.warn(`Unknown action: ${step.action}`);
      }
    } catch (err) {
      console.error(`Step ${index + 1} failed:`, err.message);
      break;
    }
  }

  await browser.close();
  console.log('Run complete.');
}

main().catch(err => {
  console.error('Runner failed:', err.message);
  process.exit(1);
});
