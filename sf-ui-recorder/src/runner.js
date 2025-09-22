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
    return 300;
  }
  if (typeof waitFor.ms === 'number') {
    return waitFor.ms;
  }
  switch (waitFor.type) {
    case 'networkidle':
      return 2000;
    case 'dom':
      return 800;
    case 'short':
    default:
      return 500;
  }
}

async function applyWait(page, waitFor) {
  const duration = waitDuration(waitFor);
  await wait(page, duration);
}

async function waitForNetworkIdle(page, timeout = 15000) {
  if (!page || typeof page.waitForNetworkIdle !== 'function') {
    return;
  }
  try {
    await page.waitForNetworkIdle({ idleTime: 500, timeout });
  } catch (err) {
    // Allow execution to continue when Lightning keeps the network busy.
  }
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

function shouldWaitForNetworkIdle(step) {
  if (!step) {
    return false;
  }

  if (step.waitFor && step.waitFor.type === 'networkidle') {
    return true;
  }

  if (!step.selector) {
    return false;
  }
  const selector = step.selector;
  if (selector.type === 'role') {
    const role = String(selector.role || '').toLowerCase();
    const name = String(selector.name || '').toLowerCase();
    if (['menuitem', 'tab', 'link', 'option'].includes(role)) {
      return true;
    }
    if (role === 'button' && name) {
      if (/\b(save|setup|settings)\b/.test(name)) {
        return true;
      }
      if (/\b(field service settings|optimization|optimización|logic|lógica)\b/.test(name)) {
        return true;
      }
    }
  }
  if (selector.type === 'text' || selector.type === 'label') {
    const text = String(selector.text || selector.value || '').toLowerCase();
    if (!text) {
      return false;
    }
    if (/\b(save|setup|settings)\b/.test(text)) {
      return true;
    }
    if (/\b(field service settings|optimization|optimización|logic|lógica)\b/.test(text)) {
      return true;
    }
  }
  return false;
}

async function performClick(page, step, timeoutOverride, debugMode) {
  const handles = await resolveHandle(page, step.selector, {
    timeout: timeoutOverride
  });
  const [primaryHandle, ...extraHandles] = handles;
  if (!primaryHandle) {
    throw new Error('Selector did not resolve to an element.');
  }
  const target = await ensureClickable(page, primaryHandle);
  await target.evaluate(el => {
    if (el && el.scrollIntoView) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    }
  });

  let clickCompleted = false;
  let fallbackUsed = false;
  let primaryError;

  try {
    try {
      await target.click({ delay: 10 });
      clickCompleted = true;
    } catch (err) {
      primaryError = err;
      try {
        await target.evaluate(el => {
          if (el) {
            el.click();
          }
        });
        fallbackUsed = true;
        await wait(page, 150);
        await target.click({ delay: 10 });
        clickCompleted = true;
      } catch (retryError) {
        if (debugMode) {
          console.warn('DOM click fallback retry failed:', retryError.message);
        }
        throw primaryError;
      }
    }

    if (fallbackUsed && debugMode) {
      console.warn('Puppeteer click fallback succeeded via DOM click + retry.');
    }

    if (clickCompleted && shouldWaitForNetworkIdle(step)) {
      await waitForNetworkIdle(page);
    }

    if (clickCompleted) {
      await applyWait(page, step.waitFor);
    }
  } finally {
    try {
      await target.dispose();
    } catch (disposeErr) {
      // ignore disposal issues
    }
    for (const extra of extraHandles) {
      if (!extra) {
        continue;
      }
      try {
        await extra.dispose();
      } catch (err) {
        // ignore disposal issues
      }
    }
  }
}

async function performType(page, step, timeoutOverride) {
  const handles = await resolveHandle(page, step.selector, {
    timeout: timeoutOverride
  });
  const [handle, ...extraHandles] = handles;
  if (!handle) {
    throw new Error('Selector did not resolve to an element.');
  }
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

  try {
    await handle.dispose();
  } catch (err) {
    // ignore disposal issues
  }

  for (const extra of extraHandles) {
    if (!extra) {
      continue;
    }
    try {
      await extra.dispose();
    } catch (err) {
      // ignore disposal issues
    }
  }
}

async function performWait(page, step) {
  await applyWait(page, step.waitFor);
}

async function captureDiagnostics(page, step, index, error, debugMode) {
  console.error('--- Debug diagnostics ---');
  console.error(`Step ${index + 1} selector:`, step.selector);
  console.error('Error:', error && error.message ? error.message : error);

  if (step.selector && step.selector.type === 'text') {
    const textValue = step.selector.text ?? step.selector.value ?? '';
    const matchMode = step.selector.match || 'equals';
    if (matchMode === 'regex') {
      console.error(`Regex pattern used: /${textValue}/`);
    }

    if (debugMode) {
      try {
        const variants = buildTextVariants(textValue);
        console.error('Text variants considered:', variants.join(' | '));
        const report = await debugTextMatches(page, textValue, 10);
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
    } else {
      console.error('Re-run with --debug to inspect text variants.');
    }
  } else if (!debugMode) {
    console.error('Re-run with --debug for additional diagnostics.');
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
    boolean: ['headful', 'debug', 'no-validate'],
    alias: { org: 'o', steps: 's', ret: 'r', headful: 'H', timeout: 't', debug: 'd', 'no-validate': 'n' }
  });

  const orgAlias = argv.org;
  const stepsPath = argv.steps;
  const headless = !argv.headful;
  const selectorTimeout = argv.timeout !== undefined ? Number(argv.timeout) : undefined;
  const debugMode = Boolean(argv.debug);
  const skipValidation = Boolean(argv['no-validate']);

  if (Number.isNaN(selectorTimeout)) {
    console.error('Invalid --timeout value. Expected a number of milliseconds.');
    process.exit(1);
  }

  if (!orgAlias || !stepsPath) {
    console.error('Usage: node src/runner.js --org <alias> --steps <file> [--ret <retURL>] [--headful] [--no-validate]');
    process.exit(1);
  }

  const plan = loadSteps(stepsPath);
  const isArrayRoot = Array.isArray(plan);
  const steps = isArrayRoot ? plan : (plan && Array.isArray(plan.steps) ? plan.steps : null);
  if (!steps) {
    console.error('Invalid steps root: expected array or {steps:[]}.');
    process.exit(1);
  }

  if (!skipValidation) {
    const schema = loadSchema();
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    const rootToValidate = isArrayRoot ? plan : plan;
    if (!validate(rootToValidate)) {
      console.error('Steps file failed validation:', validate.errors);
      process.exit(1);
    }
  }

  let retURL = argv.ret;
  if (!retURL && !isArrayRoot && plan && plan.start && typeof plan.start.retURL === 'string') {
    retURL = plan.start.retURL;
  }
  retURL = retURL || DEFAULT_RET_URL;

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
          await performClick(page, step, selectorTimeout, debugMode);
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
      await captureDiagnostics(page, step, index, err, debugMode);
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
