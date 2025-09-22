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

  const describeSelector = selector => {
    if (!selector) {
      return 'unknown';
    }
    if (selector.type === 'role') {
      return `role:${selector.role} name:${selector.name}`;
    }
    if (selector.type === 'text') {
      const qualifier = selector.match && selector.match !== 'equals' ? ` (${selector.match})` : '';
      return `text:${selector.text}${qualifier}`;
    }
    if (selector.type === 'label') {
      return `label:${selector.text}`;
    }
    return `${selector.type}:${selector.value}`;
  };

  let writeChain = Promise.resolve();
  const saveStep = step => {
    writeChain = writeChain.then(async () => {
      steps.push(step);
      await fs.promises.writeFile(outputPath, JSON.stringify(steps, null, 2));
      console.log(`Recorded ${step.action} -> ${describeSelector(step.selector)}`);
    }).catch(err => {
      console.error('Failed to persist step:', err.message);
    });
  };

  const viewport = { width: 1600, height: 900 };
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: viewport,
    args: ['--disable-infobars', `--window-size=${viewport.width},${viewport.height}`]
  });

  const [page] = await browser.pages();
  await page.setViewport(viewport);
  page.setDefaultTimeout(15000);

  await page.exposeFunction('sfRecordEvent', step => {
    if (!step || !step.selector) {
      return;
    }
    saveStep(step);
  });

  await page.evaluateOnNewDocument(() => {
    window.__sfRecorderReady = false;

    function attachRecorder() {
      if (window.__sfRecorderInjected) {
        window.__sfRecorderReady = true;
        return;
      }
      window.__sfRecorderInjected = true;

      window.CSS = window.CSS || {};
      if (typeof window.CSS.escape !== 'function') {
        window.CSS.escape = function (value) {
          return String(value).replace(/([\\"'\[\]#.:>+~*=^$|])/g, '\\$1');
        };
      }

      const MAX_TEXT_LENGTH = 80;
      const PRIMARY_ACTIONABLE_QUERY = '[role="menuitem"],[role="option"],[role="button"],button,a,[role="tab"],[role="link"],input,textarea,select';
      const CLOSEST_ACTIONABLE_QUERY = `${PRIMARY_ACTIONABLE_QUERY},[data-testid],[title],[aria-label]`;
      const MENU_CONTAINER_QUERY = '[role="menuitem"],[role="option"],[role="button"],[role="tab"],[role="link"],button,a';
      const normalize = text => (text || '').replace(/\s+/g, ' ').trim();
      const limit = text => {
        const normalized = normalize(text);
        if (!normalized) {
          return '';
        }
        return normalized.length > MAX_TEXT_LENGTH ? normalized.slice(0, MAX_TEXT_LENGTH).trim() : normalized;
      };

      function nextCandidate(node) {
        if (!node) {
          return null;
        }
        if (node.assignedSlot) {
          return node.assignedSlot;
        }
        if (node.parentElement) {
          return node.parentElement;
        }
        if (node.getRootNode) {
          const root = node.getRootNode();
          if (root && root.host) {
            return root.host;
          }
        }
        return null;
      }

      function findLabelFor(el) {
        if (!el) {
          return null;
        }
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
        let current = el.parentElement;
        while (current) {
          if (current.tagName === 'LABEL') {
            return current;
          }
          current = current.parentElement;
        }
        return null;
      }

      function accessibleName(el) {
        if (!(el instanceof Element)) {
          return '';
        }

        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) {
          const limited = limit(ariaLabel);
          if (limited) {
            return limited;
          }
        }

        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
          const ids = labelledBy.split(/\s+/).filter(Boolean);
          const parts = ids.map(id => {
            const label = document.getElementById(id);
            return label ? normalize(label.textContent) : '';
          }).filter(Boolean);
          if (parts.length) {
            const combined = limit(parts.join(' '));
            if (combined) {
              return combined;
            }
          }
        }

        const title = el.getAttribute('title');
        if (title) {
          const limited = limit(title);
          if (limited) {
            return limited;
          }
        }

        const visible = limit(el.innerText || el.textContent);
        if (visible) {
          return visible;
        }

        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          const placeholder = el.getAttribute('placeholder');
          if (placeholder) {
            const limited = limit(placeholder);
            if (limited) {
              return limited;
            }
          }
        }

        return '';
      }

      function labelTextForInput(el) {
        const label = findLabelFor(el);
        if (label) {
          const text = limit(label.textContent);
          if (text) {
            return text;
          }
        }
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
          const placeholder = el.getAttribute('placeholder');
          if (placeholder) {
            const text = limit(placeholder);
            if (text) {
              return text;
            }
          }
        }
        const aria = el.getAttribute('aria-label');
        if (aria) {
          const text = limit(aria);
          if (text) {
            return text;
          }
        }
        return '';
      }

      function absoluteXPath(el) {
        if (!(el instanceof Element)) {
          return '';
        }
        const segments = [];
        let current = el;
        while (current && current.nodeType === 1) {
          let index = 1;
          let sibling = current.previousSibling;
          while (sibling) {
            if (sibling.nodeType === 1 && sibling.nodeName === current.nodeName) {
              index += 1;
            }
            sibling = sibling.previousSibling;
          }
          segments.unshift(`${current.nodeName.toLowerCase()}[${index}]`);
          const parent = current.parentNode || (current.getRootNode && current.getRootNode().host);
          if (!parent || parent === current || parent.nodeType === 9) {
            break;
          }
          current = parent;
        }
        return '/' + segments.join('/');
      }

      function climbFor(element, predicate) {
        const visited = new Set();
        let current = element;
        while (current && !visited.has(current)) {
          visited.add(current);
          if (current instanceof Element && predicate(current)) {
            return current;
          }
          current = nextCandidate(current);
        }
        return null;
      }

      function closestActionable(node) {
        let current = node;
        while (current) {
          if (current instanceof Element) {
            if (typeof current.closest === 'function') {
              const found = current.closest(CLOSEST_ACTIONABLE_QUERY);
              if (found) {
                return found;
              }
            }
            if (current.matches && current.matches(CLOSEST_ACTIONABLE_QUERY)) {
              return current;
            }
          }
          current = nextCandidate(current);
        }
        return null;
      }

      function isIconLike(el) {
        if (!(el instanceof Element)) {
          return false;
        }
        const tag = el.tagName.toLowerCase();
        if (
          tag === 'svg' ||
          tag === 'use' ||
          tag === 'path' ||
          tag === 'i' ||
          tag === 'lightning-icon' ||
          tag === 'c-icon' ||
          tag === 'lightning-primitive-icon' ||
          tag === 'lightning-button-icon'
        ) {
          return true;
        }
        if (el.matches && el.matches('lightning-icon, c-icon, lightning-primitive-icon, lightning-button-icon, lightning-button-icon-stateful')) {
          return true;
        }
        if (el.classList && Array.from(el.classList).some(cls => cls.startsWith('slds-icon'))) {
          return true;
        }
        return false;
      }

      function isTinyClickTarget(target) {
        if (!(target instanceof Element)) {
          return false;
        }
        const text = limit(target.innerText || target.textContent);
        if (text === '+') {
          return true;
        }
        if (text && text.length <= 2) {
          return true;
        }
        return isIconLike(target);
      }

      function findMenuContainer(path, fallback) {
        const items = Array.isArray(path) ? path : [];
        for (const node of items) {
          if (!(node instanceof Element)) {
            continue;
          }
          const container = climbFor(node, el => {
            if (!(el instanceof Element) || !el.matches) {
              return false;
            }
            if (!el.matches(MENU_CONTAINER_QUERY)) {
              return false;
            }
            const name = accessibleName(el);
            return !!(name && name.length > 2);
          });
          if (container) {
            return container;
          }
        }

        if (fallback && fallback.matches && fallback.matches(MENU_CONTAINER_QUERY)) {
          const fallbackName = accessibleName(fallback);
          if (fallbackName && fallbackName.length > 2) {
            return fallback;
          }
        }

        return null;
      }

      function findActionable(path) {
        const items = Array.isArray(path) ? path : [];
        const elements = items.filter(node => node instanceof Element);

        for (const element of elements) {
          const candidate = closestActionable(element);
          if (candidate && candidate.matches && candidate.matches(PRIMARY_ACTIONABLE_QUERY)) {
            return candidate;
          }
        }

        for (const element of elements) {
          const candidate = closestActionable(element);
          if (candidate && candidate.hasAttribute && candidate.hasAttribute('data-testid')) {
            return candidate;
          }
        }

        for (const element of elements) {
          const candidate = closestActionable(element);
          if (
            candidate &&
            candidate.hasAttribute &&
            (candidate.hasAttribute('title') || candidate.hasAttribute('aria-label'))
          ) {
            return candidate;
          }
        }

        return elements.length ? elements[0] : null;
      }

      function buildSelector(target, path) {
        const element = findActionable(path) || (target instanceof Element ? target : null);
        if (!element) {
          return null;
        }

        if (target && isTinyClickTarget(target)) {
          const container = findMenuContainer(path, element);
          if (container) {
            const name = accessibleName(container);
            if (name) {
              let role = (container.getAttribute('role') || '').trim().toLowerCase();
              if (!role && container.matches && container.matches('button')) {
                role = 'button';
              }
              if (role) {
                return { type: 'role', role, name };
              }
              return { type: 'text', text: name };
            }
          }
        }

        const dataTestId = element.getAttribute('data-testid') || (element.dataset && element.dataset.testid);
        if (dataTestId) {
          return { type: 'dataTestId', value: limit(dataTestId) };
        }

        const role = (element.getAttribute('role') || '').trim().toLowerCase();
        const roleNames = new Set(['menuitem', 'option', 'button', 'tab', 'link']);
        if (role && roleNames.has(role)) {
          const name = accessibleName(element);
          if (name) {
            return { type: 'role', role, name };
          }
        }

        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
          const labelText = labelTextForInput(element);
          if (labelText) {
            return { type: 'label', text: labelText };
          }
        }

        const ariaName = accessibleName(element);
        if (ariaName) {
          return { type: 'text', text: ariaName };
        }

        const xpath = absoluteXPath(element);
        if (xpath) {
          return { type: 'xpath', value: xpath };
        }

        return null;
      }

      function recordClick(event) {
        if (event.button !== 0) {
          return;
        }
        const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
        const selector = buildSelector(event.target, path);
        if (!selector) {
          return;
        }
        window.sfRecordEvent({
          action: 'click',
          selector,
          timestamp: Date.now(),
          waitFor: { type: 'short' }
        });
      }

      function recordChange(event) {
        const target = event.target;
        if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) {
          return;
        }
        const path = typeof event.composedPath === 'function' ? event.composedPath() : [target];
        const selector = buildSelector(target, path);
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

      window.__sfRecorderReady = true;
      console.log('[SF Recorder] Listeners attached.');
    }

    if (document.readyState === 'loading') {
      window.addEventListener('DOMContentLoaded', attachRecorder, { once: true });
    } else {
      attachRecorder();
    }
  });

  console.log(`Opening ${frontdoorUrl}`);
  await page.goto(frontdoorUrl, { waitUntil: 'networkidle2' });

  try {
    await page.waitForFunction(() => window.__sfRecorderReady === true, { timeout: 45000, polling: 250 });
    console.log('Recorder listeners ready.');
  } catch (err) {
    console.warn('Recorder listeners did not confirm readiness before timeout. Interactions may not be captured immediately.');
  }

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
