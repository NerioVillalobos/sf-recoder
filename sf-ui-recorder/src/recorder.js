const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const minimist = require('minimist');
const { getOrgInfo, buildFrontdoorUrl, DEFAULT_RET_URL } = require('./sf');

async function main() {
  const argv = minimist(process.argv.slice(2), {
    string: ['org', 'out', 'ret'],
    alias: { org: 'o', out: 'f', ret: 'r' }
  });

  const orgAlias = argv.org;
  const outputPath = path.resolve(argv.out || 'steps/recording.json');
  const retURL = argv.ret || DEFAULT_RET_URL;

  if (!orgAlias) {
    console.error('Missing --org <alias> argument.');
    process.exit(1);
  }

  const { instanceUrl, accessToken } = getOrgInfo(orgAlias);
  const frontdoorUrl = buildFrontdoorUrl(instanceUrl, accessToken, retURL);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  let steps = [];
  if (fs.existsSync(outputPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      if (Array.isArray(existing)) {
        steps = existing;
      }
    } catch (err) {
      console.warn(`Could not parse existing steps file. Starting fresh. (${err.message})`);
    }
  }

  let writeChain = Promise.resolve();
  const saveStep = step => {
    writeChain = writeChain.then(async () => {
      steps.push(step);
      await fs.promises.writeFile(outputPath, JSON.stringify(steps, null, 2));
      console.log(`Recorded ${step.action} -> ${step.selector.type}:${step.selector.value}`);
    }).catch(err => {
      console.error('Failed to persist step:', err.message);
    });
  };

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ['--disable-infobars']
  });

  const [page] = await browser.pages();
  page.setDefaultTimeout(15000);

  console.log(`Opening ${frontdoorUrl}`);
  await page.goto(frontdoorUrl, { waitUntil: 'networkidle2' });

  await page.exposeFunction('sfRecordEvent', step => {
    if (!step || !step.selector) {
      return;
    }
    saveStep(step);
  });

  await page.evaluate(() => {
    if (window.__sfRecorderInjected) {
      return;
    }
    window.__sfRecorderInjected = true;

    window.CSS = window.CSS || {};
    if (typeof window.CSS.escape !== 'function') {
      window.CSS.escape = function (value) {
        return String(value).replace(/([\\"'\[\]#.:>+~*=^$|])/g, '\\$1');
      };
    }

    const normalize = text => (text || '').replace(/\s+/g, ' ').trim();

    function findLabelFor(el) {
      if (!el) return null;
      if (el.labels && el.labels.length > 0) {
        return el.labels[0];
      }
      const id = el.getAttribute('id');
      if (id) {
        const direct = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (direct) {
          return direct;
        }
      }
      let parent = el.parentElement;
      while (parent) {
        if (parent.tagName === 'LABEL') {
          return parent;
        }
        parent = parent.parentElement;
      }
      return null;
    }

    function cssPath(el) {
      if (!(el instanceof Element)) {
        return null;
      }
      const parts = [];
      let current = el;
      while (current && current.nodeType === 1 && current !== document.body) {
        let selector = current.tagName.toLowerCase();
        if (current.id) {
          selector = `${selector}#${current.id}`;
          parts.unshift(selector);
          break;
        } else {
          let siblingIndex = 1;
          let sibling = current.previousElementSibling;
          while (sibling) {
            if (sibling.tagName === current.tagName) {
              siblingIndex += 1;
            }
            sibling = sibling.previousElementSibling;
          }
          selector += `:nth-of-type(${siblingIndex})`;
        }
        parts.unshift(selector);
        current = current.parentElement;
      }
      return parts.join(' > ');
    }

    function buildSelector(target) {
      if (!target || !(target instanceof Element)) {
        return null;
      }

      const actionable = target.closest('[data-testid], button, a, input, textarea, select, [role="button"], [role="menuitem"], [role="tab"], lightning-button, lightning-base-combobox, lightning-input');
      const element = actionable || target;

      const dataTestId = element.getAttribute('data-testid') || element.dataset.testid;
      if (dataTestId) {
        return { type: 'dataTestId', value: normalize(dataTestId) };
      }

      const label = findLabelFor(element);
      if (label) {
        const text = normalize(label.textContent);
        if (text) {
          return { type: 'label', value: text };
        }
      }

      const aria = element.getAttribute('aria-label');
      if (aria) {
        return { type: 'label', value: normalize(aria) };
      }

      const textContent = normalize(element.innerText || element.textContent);
      if (textContent && textContent.length <= 120) {
        return { type: 'text', value: textContent };
      }

      if (element.id) {
        return { type: 'css', value: `#${element.id}` };
      }

      const role = element.getAttribute('role');
      if (role) {
        return { type: 'role', value: role };
      }

      const path = cssPath(element);
      if (path) {
        return { type: 'css', value: path };
      }

      return null;
    }

    function recordClick(event) {
      if (event.button !== 0) {
        return;
      }
      const selector = buildSelector(event.target);
      if (!selector) {
        return;
      }
      window.sfRecordEvent({
        action: 'click',
        selector,
        waitFor: { type: 'short' }
      });
    }

    function recordChange(event) {
      const target = event.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) {
        return;
      }
      const selector = buildSelector(target);
      if (!selector) {
        return;
      }
      const payload = {
        action: 'type',
        selector,
        value: target.value,
        delay: 10
      };
      window.sfRecordEvent(payload);
    }

    document.addEventListener('click', recordClick, true);
    document.addEventListener('change', recordChange, true);

    console.log('[SF Recorder] Listeners attached.');
  });

  console.log(`Recording interactions. Output: ${outputPath}`);
  console.log('Press Ctrl+C to finish.');

  process.on('SIGINT', async () => {
    console.log('\nStopping recorder...');
    await browser.close();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Recorder failed:', err.message);
  process.exit(1);
});
