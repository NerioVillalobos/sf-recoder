const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const minimist = require('minimist');
const Ajv = require('ajv');
const { getOrgInfo, buildFrontdoorUrl, DEFAULT_RET_URL } = require('./sf');
const { resolveHandle, buildTextVariants, debugTextMatches } = require('./selectors');

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

async function ensureClickable(page, handle) {
  const resultHandle = await handle.evaluateHandle(element => {
    const ACTIONABLE_SELECTOR = [
      'button',
      'a',
      'input',
      'textarea',
      'select',
      '[role="button"]',
      '[role="menuitem"]',
      '[role="option"]',
      '[role="tab"]',
      '[role="link"]',
      '[role="radio"]',
      '[role="checkbox"]',
      '[role="switch"]'
    ].join(',');

    const isElement = node => node instanceof Element;

    const isActionable = node => {
      if (!isElement(node)) {
        return false;
      }
      return typeof node.matches === 'function' && node.matches(ACTIONABLE_SELECTOR);
    };

    const enqueueShadowChildren = (queue, node) => {
      if (!node.shadowRoot) {
        return;
      }
      queue.push(...node.shadowRoot.children);
      const slots = Array.from(node.shadowRoot.querySelectorAll('slot'));
      for (const slot of slots) {
        if (typeof slot.assignedElements === 'function') {
          queue.push(...slot.assignedElements());
        }
      }
    };

    const visited = new Set();
    const queue = [];
    if (isElement(element)) {
      queue.push(element);
    }

    while (queue.length) {
      const node = queue.shift();
      if (!isElement(node) || visited.has(node)) {
        continue;
      }
      visited.add(node);

      if (isActionable(node)) {
        return node;
      }

      enqueueShadowChildren(queue, node);
      queue.push(...node.children);
    }

    return isElement(element) ? element : null;
  });

  const element = resultHandle.asElement();
  if (!element) {
    await resultHandle.dispose();
    const fallback = handle.asElement();
    if (fallback) {
      return fallback;
    }
    throw new Error('Selector did not resolve to a DOM element.');
  }

  await handle.dispose();
  return element;
}

async function performClick(page, step, timeoutOverride) {
  const handle = await resolveHandle(page, step.selector, {
    timeout: timeoutOverride
  });
  const target = await ensureClickable(page, handle);
  await target.evaluate(el => {
    if (el.scrollIntoView) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    }
  });
  try {
    await target.click({ delay: 50 });
  } catch (err) {
    try {
      await target.evaluate(el => {
        if (el) {
          el.click();
        }
      });
      console.warn('Puppeteer click failed; used DOM click fallback.');
    } catch (fallbackError) {
      throw err;
    }
  }
  await applyWait(page, step.waitFor);
}

async function performType(page, step, timeoutOverride) {
  const handle = await resolveHandle(page, step.selector, {
    timeout: timeoutOverride
  });
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

async function captureDiagnostics(page, step, index, error) {
  console.error('--- Debug diagnostics ---');
  console.error(`Step ${index + 1} selector:`, step.selector);
  console.error('Error:', error && error.message ? error.message : error);

  if (step.selector && step.selector.type === 'text') {
    try {
      const variants = buildTextVariants(step.selector.value);
      console.error('Text variants considered:', variants.join(' | '));
      const report = await debugTextMatches(page, step.selector.value, 10);
      if (report.matches.length === 0) {
        console.error('No elements contained any of the variants.');
      } else {
        console.error('Closest matches:');
        report.matches.forEach((match, idx) => {
          console.error(
            `  [${idx + 1}] <${match.tag}> via ${match.match.kind} -> "${match.text}"`
          );
          if (match.dataTestId) {
            console.error(`       data-testid: ${match.dataTestId}`);
          }
          if (match.ariaLabel) {
            console.error(`       aria-label: ${match.ariaLabel}`);
          }
          if (match.placeholder) {
            console.error(`       placeholder: ${match.placeholder}`);
          }
          if (match.role) {
            console.error(`       role: ${match.role}`);
          }
          if (match.cssPath) {
            console.error(`       css: ${match.cssPath}`);
          }
        });
      }
    } catch (diagErr) {
      console.error('Failed to analyze text matches:', diagErr.message);
    }
  }

  const screenshotPath = path.resolve(`debug-step-${index + 1}.png`);
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.error(`Saved page screenshot to ${screenshotPath}`);
  } catch (shotErr) {
    console.error('Failed to capture screenshot:', shotErr.message);
  }

  console.error('--- End diagnostics ---');
}

async function main() {
  const argv = minimist(process.argv.slice(2), {
    string: ['org', 'steps', 'ret', 'timeout'],
    boolean: ['headful', 'debug'],
    alias: { org: 'o', steps: 's', ret: 'r', headful: 'H', timeout: 't', debug: 'd' }
  });

  const orgAlias = argv.org;
  const stepsPath = argv.steps;
  const retURL = argv.ret || DEFAULT_RET_URL;
  const headless = !argv.headful;
  const selectorTimeout = argv.timeout !== undefined ? Number(argv.timeout) : undefined;
  const debugMode = Boolean(argv.debug);

  if (Number.isNaN(selectorTimeout)) {
    console.error('Invalid --timeout value. Expected a number of milliseconds.');
    process.exit(1);
  }

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

  const viewport = { width: 1600, height: 900 };
  const browser = await puppeteer.launch({
    headless: headless ? 'new' : false,
    defaultViewport: viewport,
    args: ['--disable-infobars', `--window-size=${viewport.width},${viewport.height}`]
  });

  const page = await browser.newPage();
  await page.setViewport(viewport);
  page.setDefaultTimeout(15000);

  console.log(`Opening ${frontdoorUrl}`);
  await page.goto(frontdoorUrl, { waitUntil: 'networkidle2' });
  await wait(page, 1000);

  for (const [index, step] of steps.entries()) {
    console.log(`Executing step ${index + 1}/${steps.length}: ${step.action}`);
    try {
      switch (step.action) {
        case 'click':
          await performClick(page, step, selectorTimeout);
          break;
        case 'type':
          await performType(page, step, selectorTimeout);
          break;
        case 'wait':
          await performWait(page, step);
          break;
        default:
          console.warn(`Unknown action: ${step.action}`);
      }
    } catch (err) {
      console.error(`Step ${index + 1} failed:`, err.message);
      if (debugMode) {
        await captureDiagnostics(page, step, index, err);
      }
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
