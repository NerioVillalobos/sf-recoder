const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const minimist = require('minimist');
const { getOrgInfo, buildFrontdoorUrl, DEFAULT_RET_URL } = require('./sf');

function clampAreaClip(data) {
  if (!data) {
    return null;
  }
  const scrollX = Number.isFinite(data.scrollX) ? data.scrollX : 0;
  const scrollY = Number.isFinite(data.scrollY) ? data.scrollY : 0;
  const frameOffsetX = Number.isFinite(data.frameOffsetX) ? data.frameOffsetX : 0;
  const frameOffsetY = Number.isFinite(data.frameOffsetY) ? data.frameOffsetY : 0;
  const originX = Number.isFinite(data.x) ? data.x : 0;
  const originY = Number.isFinite(data.y) ? data.y : 0;
  const width = Number.isFinite(data.width) ? data.width : 0;
  const height = Number.isFinite(data.height) ? data.height : 0;
  const maxWidth = Number.isFinite(data.pageWidth) ? data.pageWidth : null;
  const maxHeight = Number.isFinite(data.pageHeight) ? data.pageHeight : null;

  const clipX = Math.max(0, originX + scrollX + frameOffsetX);
  const clipY = Math.max(0, originY + scrollY + frameOffsetY);
  let clipWidth = Math.max(1, width);
  let clipHeight = Math.max(1, height);

  if (maxWidth !== null) {
    clipWidth = Math.min(clipWidth, Math.max(1, maxWidth - clipX));
  }
  if (maxHeight !== null) {
    clipHeight = Math.min(clipHeight, Math.max(1, maxHeight - clipY));
  }

  if (clipWidth <= 0 || clipHeight <= 0) {
    return null;
  }

  return {
    x: clipX,
    y: clipY,
    width: clipWidth,
    height: clipHeight
  };
}

async function main() {
  const argv = minimist(process.argv.slice(2), {
    string: ['org', 'out', 'ret'],
    boolean: ['scan', 'snap-area'],
    alias: { org: 'o', out: 'f', ret: 'r' }
  });

  const isScan = Boolean(argv.scan);
  const orgAlias = argv.org;
  const timestamp = new Date().toISOString().replace(/[:]/g, '-');
  const scanDefaultRelative = path.join('maps', `${timestamp}-map.json`);
  const outputPath = path.resolve(argv.out || (isScan ? scanDefaultRelative : 'steps/recording.json'));
  const retURL = argv.ret || DEFAULT_RET_URL;
  const snapArea = Boolean(argv['snap-area']);

  if (!orgAlias) {
    console.error('Missing --org <alias> argument.');
    process.exit(1);
  }

  const { instanceUrl, accessToken } = getOrgInfo(orgAlias);
  const frontdoorUrl = buildFrontdoorUrl(instanceUrl, accessToken, retURL);

  const outputDir = path.dirname(outputPath);
  fs.mkdirSync(outputDir, { recursive: true });
  const shotsDir = snapArea ? path.join(outputDir, 'shots') : null;

  let planRoot = null;
  let steps = [];
  let describeSelector = () => 'unknown';
  let writeChain = Promise.resolve();
  let persistPlan = async () => {};
  let saveStep = () => {};
  let activePage = null;

  if (!isScan) {
    planRoot = { version: 1, steps: [] };
    if (fs.existsSync(outputPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
        if (Array.isArray(existing)) {
          planRoot = { version: 1, steps: existing };
        } else if (existing && typeof existing === 'object') {
          planRoot = existing;
        }
      } catch (err) {
        console.warn(`Could not parse existing steps file. Starting fresh. (${err.message})`);
      }
    }

    if (!planRoot || typeof planRoot !== 'object') {
      planRoot = { version: 1, steps: [] };
    }

    if (!Array.isArray(planRoot.steps)) {
      planRoot.steps = [];
    }

    if (planRoot.version === undefined) {
      planRoot.version = 1;
    }

    steps = planRoot.steps;

    describeSelector = selector => {
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

    persistPlan = async () => {
      await fs.promises.writeFile(outputPath, JSON.stringify(planRoot, null, 2));
    };

    saveStep = step => {
      writeChain = writeChain
        .then(async () => {
          const areaClip = step.__areaClip || null;
          delete step.__areaClip;

          if (snapArea && shotsDir && activePage && step.action === 'click' && areaClip) {
            const clip = clampAreaClip(areaClip);
            if (clip) {
              await fs.promises.mkdir(shotsDir, { recursive: true });
              const index = steps.length + 1;
              const filename = `${index}-area.png`;
              const shotPath = path.join(shotsDir, filename);
              try {
                await activePage.screenshot({ path: shotPath, clip });
                const relativeNote = path.posix.join('shots', filename);
                const areaNote = `areaShot: ${relativeNote}`;
                step.note = step.note ? `${step.note}; ${areaNote}` : areaNote;
              } catch (shotErr) {
                console.warn(`Failed to capture area snapshot: ${shotErr.message}`);
              }
            }
          }

          steps.push(step);
          await persistPlan();
          console.log(`Recorded ${step.action} -> ${describeSelector(step.selector)}`);
        })
        .catch(err => {
          console.error('Failed to persist step:', err.message);
        });
    };

  }

  const viewport = { width: 1600, height: 900 };
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: viewport,
    args: ['--disable-infobars', `--window-size=${viewport.width},${viewport.height}`]
  });

  const [page] = await browser.pages();
  await page.setViewport(viewport);
  page.setDefaultTimeout(15000);
  activePage = page;

  if (isScan) {
    console.log(`Opening ${frontdoorUrl}`);
    await page.goto(frontdoorUrl, { waitUntil: 'networkidle2' });
    try {
      const uiMap = await scanPage(page);
      await fs.promises.writeFile(outputPath, JSON.stringify(uiMap, null, 2));
      console.log(`Saved UI map to: ${outputPath}`);
    } finally {
      await browser.close();
    }
    return;
  }

  await page.exposeFunction('sfRecordEvent', step => {
    if (!step || !step.selector) {
      return;
    }
    saveStep(step);
  });

  await page.exposeFunction('sfRecorderLog', message => {
    if (typeof message === 'string' && message.trim()) {
      console.log(message.trim());
    }
  });

  page.on('console', msg => {
    try {
      const text = msg.text();
      if (text) {
        console.log(text);
      }
    } catch (err) {
      // ignore console relay issues
    }
  });

  const attachToFrame = async frame => {
    if (!frame || frame.isDetached()) {
      return;
    }
    try {
      await frame.evaluate(() => {
        if (window.__sfRecorderAttach) {
          window.__sfRecorderAttach();
        }
      });
    } catch (err) {
      // cross-origin frames are ignored
    }
  };

  const frameListener = frame => {
    attachToFrame(frame);
  };

  page.on('frameattached', frameListener);
  page.on('framenavigated', frameListener);

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
      const STATUS_SUMMARY_PATTERN = /^\d+\s+statuses selected$/i;
      const FIELD_SERVICE_OPTION = /field service settings/i;
      const APP_LAUNCHER_TEXT = /app launcher/i;
      const APP_LAUNCHER_SEARCH = /search apps and items/i;
      const PRIMARY_ACTIONABLE_QUERY = '[role="menuitem"],[role="option"],[role="button"],[role="searchbox"],button,a,[role="tab"],[role="link"],input,textarea,select';
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

      const xpathLiteral = value => {
        const safe = String(value);
        if (!safe.includes("'")) {
          return `'${safe}'`;
        }
        return `concat(${safe.split("'").map(part => `'${part}'`).join(", '\'', ")})`;
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

      function buildCssPath(el) {
        if (!(el instanceof Element)) {
          return '';
        }
        if (el.id) {
          return `#${CSS.escape(el.id)}`;
        }
        const segments = [];
        let current = el;
        let depth = 0;
        while (current && current instanceof Element && depth < 5) {
          let selector = current.tagName.toLowerCase();
          const classList = current.classList ? Array.from(current.classList).filter(Boolean) : [];
          if (classList.length) {
            selector += classList
              .slice(0, 2)
              .map(cls => `.${CSS.escape(cls)}`)
              .join('');
          } else {
            let index = 1;
            let sibling = current.previousElementSibling;
            while (sibling) {
              if (sibling.tagName === current.tagName) {
                index += 1;
              }
              sibling = sibling.previousElementSibling;
            }
            selector += `:nth-of-type(${index})`;
          }
          segments.unshift(selector);
          const parent = current.parentElement;
          if (!parent || !(parent instanceof Element)) {
            break;
          }
          current = parent;
          depth += 1;
        }
        return segments.join(' > ');
      }

      function computeAreaClip(el) {
        if (!(el instanceof Element)) {
          return null;
        }
        const rect = el.getBoundingClientRect();
        if (!rect) {
          return null;
        }
        const padding = 8;
        const paddedX = Math.max(rect.x - padding, 0);
        const paddedY = Math.max(rect.y - padding, 0);
        const maxWidth = Math.max(1, window.innerWidth - paddedX);
        const maxHeight = Math.max(1, window.innerHeight - paddedY);
        const paddedWidth = Math.min(rect.width + padding * 2, maxWidth);
        const paddedHeight = Math.min(rect.height + padding * 2, maxHeight);
        if (paddedWidth <= 0 || paddedHeight <= 0) {
          return null;
        }

        let frameOffsetX = 0;
        let frameOffsetY = 0;
        try {
          if (window.frameElement && typeof window.frameElement.getBoundingClientRect === 'function') {
            const frameRect = window.frameElement.getBoundingClientRect();
            frameOffsetX = frameRect.x;
            frameOffsetY = frameRect.y;
          }
        } catch (err) {
          // ignore cross-origin access
        }

        return {
          x: paddedX,
          y: paddedY,
          width: Math.max(1, paddedWidth),
          height: Math.max(1, paddedHeight),
          scrollX: window.scrollX || window.pageXOffset || 0,
          scrollY: window.scrollY || window.pageYOffset || 0,
          frameOffsetX,
          frameOffsetY,
          pageWidth: document.documentElement ? document.documentElement.scrollWidth : window.innerWidth,
          pageHeight: document.documentElement ? document.documentElement.scrollHeight : window.innerHeight
        };
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

      function isBlockContainer(el) {
        if (!(el instanceof Element) || !el.classList) {
          return false;
        }
        return Array.from(el.classList).some(cls => cls.includes('slds-card') || cls.includes('slds-section'));
      }

      function findBlockTitle(block) {
        if (!(block instanceof Element)) {
          return '';
        }

        const titleSelectors = [
          '.slds-card__header-title',
          '.slds-card__header-title span',
          '.slds-section__title',
          '.slds-section__title-action',
          '.slds-text-heading_medium',
          '.slds-text-heading_small',
          '.slds-accordion__summary-heading',
          'header h1',
          'header h2',
          'header h3',
          'h1',
          'h2',
          'h3'
        ];

        for (const selector of titleSelectors) {
          const candidate = block.querySelector(selector);
          if (candidate) {
            const text = limit(candidate.textContent);
            if (text) {
              return text;
            }
          }
        }

        const dataLabel = block.getAttribute('data-label');
        if (dataLabel) {
          const text = limit(dataLabel);
          if (text) {
            return text;
          }
        }

        const ariaLabel = block.getAttribute('aria-label');
        if (ariaLabel) {
          const text = limit(ariaLabel);
          if (text) {
            return text;
          }
        }

        const accessible = accessibleName(block);
        if (accessible) {
          return accessible;
        }

        return '';
      }

      function findFieldContainer(element, block) {
        return climbFor(element, el => {
          if (!(el instanceof Element)) {
            return false;
          }
          if (block && el === block) {
            return false;
          }
          if (el.hasAttribute && el.hasAttribute('data-field-label')) {
            return true;
          }
          if (!el.classList) {
            return false;
          }
          const classes = Array.from(el.classList);
          return classes.some(cls =>
            cls.startsWith('slds-form-element') ||
            cls.includes('slds-form-element') ||
            cls.includes('slds-form-element__control') ||
            cls.includes('slds-form_compound') ||
            cls.includes('slds-grid')
          );
        });
      }

      function findFieldLabel(element, block) {
        const container = findFieldContainer(element, block);
        const tried = new Set();

        const pullText = node => {
          if (!node || tried.has(node)) {
            return '';
          }
          tried.add(node);
          const text = limit(node.textContent || '');
          if (text && !STATUS_SUMMARY_PATTERN.test(text)) {
            return text;
          }
          return '';
        };

        if (container) {
          if (container.hasAttribute && container.hasAttribute('data-field-label')) {
            const text = limit(container.getAttribute('data-field-label'));
            if (text) {
              return text;
            }
          }

          const labelSelectors = [
            'label',
            '.slds-form-element__label',
            '.slds-form-element__title',
            '.slds-form-element__legend',
            '.slds-form-element__control label',
            'legend'
          ];

          for (const selector of labelSelectors) {
            const candidate = container.querySelector(selector);
            const text = pullText(candidate);
            if (text) {
              return text;
            }
          }

          const aria = container.getAttribute('aria-label');
          if (aria) {
            const text = limit(aria);
            if (text) {
              return text;
            }
          }
        }

        const explicitLabel = climbFor(element, el => el instanceof Element && el.tagName === 'LABEL');
        if (explicitLabel) {
          const text = pullText(explicitLabel);
          if (text) {
            return text;
          }
        }

        const previous = element && element.previousElementSibling ? element.previousElementSibling : null;
        if (previous) {
          const text = pullText(previous);
          if (text) {
            return text;
          }
        }

        if (container) {
          const fallback = accessibleName(container);
          if (fallback && !STATUS_SUMMARY_PATTERN.test(fallback)) {
            return fallback;
          }
        }

        return '';
      }

      function buildComboboxSelector(element) {
        const block = climbFor(element, el => isBlockContainer(el));
        if (!block) {
          return null;
        }

        const blockTitle = findBlockTitle(block);
        if (!blockTitle) {
          return null;
        }

        const fieldLabel = findFieldLabel(element, block);
        if (!fieldLabel) {
          return null;
        }

        const blockLiteral = xpathLiteral(blockTitle);
        const fieldLiteral = xpathLiteral(fieldLabel);
        const xpath = `//*[normalize-space()=${blockLiteral}]/ancestor::*[contains(@class,'slds-card') or contains(@class,'slds-section')][1]//*[normalize-space()=${fieldLiteral}]/ancestor::*[self::div or self::label][1]//button[contains(@aria-haspopup,'listbox') or @role='combobox' or contains(normalize-space(.),'statuses selected')]`;

        let buttonElement = element.closest ? element.closest('button') : null;
        if (!buttonElement) {
          const fieldContainer = findFieldContainer(element, block);
          if (fieldContainer) {
            buttonElement = fieldContainer.querySelector(
              "button[aria-haspopup], button[role='combobox'], button"
            );
          }
        }

        return { xpath, blockTitle, fieldLabel, buttonElement: buttonElement || element };
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

        let areaTarget = element;

        const finalize = (selector, clipSource) => {
          if (!selector) {
            return null;
          }
          const clipTarget = clipSource || areaTarget || element;
          return {
            selector,
            areaClip: computeAreaClip(clipTarget)
          };
        };

        const isPlusLike = node => node && isTinyClickTarget(node);
        if (isPlusLike(element) || isPlusLike(target)) {
          const container = findMenuContainer(path, element);
          if (container) {
            const name = accessibleName(container);
            if (name) {
              if (typeof window.sfRecorderLog === 'function') {
                window.sfRecorderLog(`Recorded nav section: ${name}`);
              }
              areaTarget = container;
              return finalize({ type: 'text', text: name }, container);
            }
          }
        }

        const elementName = accessibleName(element);
        const elementText = elementName || limit(element.innerText || element.textContent);
        if (elementText && STATUS_SUMMARY_PATTERN.test(elementText)) {
          const combobox = buildComboboxSelector(element);
          if (combobox) {
            if (typeof window.sfRecorderLog === 'function') {
              window.sfRecorderLog(`Recorded combobox: ${combobox.blockTitle} > ${combobox.fieldLabel}`);
            }
            areaTarget = combobox.buttonElement || element;
            return finalize({ type: 'xpath', value: combobox.xpath }, areaTarget);
          }
        }

        const dataTestId = element.getAttribute('data-testid') || (element.dataset && element.dataset.testid);
        if (dataTestId) {
          return finalize({ type: 'dataTestId', value: limit(dataTestId) }, element);
        }

        const role = (element.getAttribute('role') || '').trim().toLowerCase();
        const roleNames = new Set(['menuitem', 'option', 'button', 'tab', 'link', 'searchbox']);
        if (role && roleNames.has(role)) {
          const name = elementName;
          if (name) {
            return finalize({ type: 'role', role, name }, element);
          }
        }

        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
          const labelText = labelTextForInput(element);
          if (labelText) {
            return finalize({ type: 'label', text: labelText }, element);
          }
        }

        if (elementName) {
          return finalize({ type: 'text', text: elementName }, element);
        }

        const cssSelector = buildCssPath(element);
        if (cssSelector) {
          return finalize({ type: 'css', value: cssSelector }, element);
        }

        return null;
      }

      function shouldSkipAppLauncher(selector) {
        return false;
      }

      function handleAppLauncherSelection(selector) {
        if (!selector || selector.type !== 'role') {
          return false;
        }

        const roleName = String(selector.role || '').toLowerCase();
        if (!['option', 'menuitem'].includes(roleName)) {
          return false;
        }

        const name = String(selector.name || '');
        if (!FIELD_SERVICE_OPTION.test(name)) {
          return false;
        }

        if (typeof window.sfRecorderLog === 'function') {
          window.sfRecorderLog('Recorded App Launcher choice: Field Service Settings');
        }
        return false;
      }

      function recordClick(event) {
        if (event.button !== 0) {
          return;
        }
        const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
        const capture = buildSelector(event.target, path);
        if (!capture) {
          return;
        }
        const selector = capture.selector;
        if (!selector) {
          return;
        }
        if (shouldSkipAppLauncher(selector)) {
          return;
        }
        handleAppLauncherSelection(selector);
        const step = {
          action: 'click',
          selector,
          timestamp: Date.now(),
          waitFor: { type: 'short' }
        };
        if (capture.areaClip) {
          step.__areaClip = capture.areaClip;
        }
        window.sfRecordEvent(step);
      }

      function recordChange(event) {
        const target = event.target;
        if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) {
          return;
        }
        const path = typeof event.composedPath === 'function' ? event.composedPath() : [target];
        const capture = buildSelector(target, path);
        const selector = capture && capture.selector;
        if (!selector) {
          return;
        }
        if (shouldSkipAppLauncher(selector)) {
          return;
        }
        const payload = {
          action: 'type',
          selector,
          value: target.value,
          delay: 10,
          timestamp: Date.now()
        };
        window.sfRecordEvent(payload);
      }

      document.addEventListener('click', recordClick, true);
      document.addEventListener('change', recordChange, true);

      window.__sfRecorderReady = true;
      console.log('[SF Recorder] Listeners attached.');
    }

    window.__sfRecorderAttach = attachRecorder;

    if (document.readyState === 'loading') {
      window.addEventListener('DOMContentLoaded', attachRecorder, { once: true });
    } else {
      attachRecorder();
    }
  });

  console.log(`Opening ${frontdoorUrl}`);
  await page.goto(frontdoorUrl, { waitUntil: 'networkidle2' });
  await Promise.all(page.frames().map(attachToFrame));

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

async function scanPage(page) {
  const frames = page.frames();
  const map = {
    url: page.url(),
    timestamp: new Date().toISOString(),
    frameCount: frames.length,
    frames: []
  };

  for (const frame of frames) {
    const frameUrl = frame.url();
    const frameInfo = {
      frameUrl: frameUrl || map.url,
      sameOrigin: true,
      elements: []
    };

    if (frame.isDetached()) {
      frameInfo.sameOrigin = false;
      map.frames.push(frameInfo);
      continue;
    }

    try {
      frameInfo.elements = await frame.evaluate(() => {
        const ACTIONABLE_ROLES = new Set([
          'button',
          'link',
          'menuitem',
          'option',
          'tab',
          'checkbox',
          'radio',
          'combobox',
          'textbox',
          'searchbox',
          'listbox',
          'gridcell'
        ]);

        const ACTIONABLE_TAGS = new Set([
          'button',
          'summary',
          'lightning-button',
          'lightning-button-icon',
          'lightning-button-menu',
          'lightning-menu-item',
          'lightning-base-combobox',
          'lightning-input',
          'lightning-tab',
          'lightning-badge'
        ]);

        const MAX_TEXT_LENGTH = 80;

        window.CSS = window.CSS || {};
        if (typeof window.CSS.escape !== 'function') {
          window.CSS.escape = function (value) {
            return String(value).replace(/([\\"'\[\]#.:>+~*=^$|])/g, '\\$1');
          };
        }

        const normalize = text => (text || '').replace(/\s+/g, ' ').trim();
        const limit = text => {
          const normalized = normalize(text);
          if (!normalized) {
            return '';
          }
          return normalized.length > MAX_TEXT_LENGTH ? normalized.slice(0, MAX_TEXT_LENGTH).trim() : normalized;
        };

        const normalizeAttr = text => (text || '').replace(/\s+/g, ' ').trim();

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
            const parts = ids
              .map(id => {
                const label = document.getElementById(id);
                return label ? normalize(label.textContent) : '';
              })
              .filter(Boolean);
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

          const inner = limit(el.innerText || el.textContent);
          if (inner) {
            return inner;
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

        function labelText(el) {
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

        function isVisible(el) {
          if (!(el instanceof Element)) {
            return false;
          }
          const style = window.getComputedStyle(el);
          if (!style) {
            return false;
          }
          if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
            return false;
          }
          if (parseFloat(style.opacity || '1') === 0) {
            return false;
          }
          const rect = el.getBoundingClientRect();
          if (!rect) {
            return false;
          }
          if (rect.width === 0 && rect.height === 0) {
            if (!el.getClientRects().length) {
              return false;
            }
          }
          return true;
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

        function candidateCss(el) {
          if (!(el instanceof Element)) {
            return null;
          }
          const tag = el.tagName.toLowerCase();
          const attributes = [
            'data-testid',
            'data-label',
            'data-name',
            'data-value',
            'data-target-selection-name',
            'aria-label',
            'title'
          ];
          for (const attr of attributes) {
            const raw = el.getAttribute(attr);
            if (raw) {
              const value = normalizeAttr(raw);
              if (value) {
                return `${tag}[${attr}="${CSS.escape(value)}"]`;
              }
            }
          }
          const classes = Array.from(el.classList || []).filter(cls => cls && !/\d/.test(cls));
          if (classes.length) {
            const subset = classes.slice(0, 3).map(cls => `.${CSS.escape(cls)}`).join('');
            return `${tag}${subset}`;
          }
          return null;
        }

        function guessRegion(el) {
          let current = el;
          while (current) {
            if (current.matches && current.matches('.slds-modal, .slds-modal__container, .forceModal, [role="dialog"]')) {
              return 'dialog';
            }
            if (current.matches && current.matches('nav, .slds-nav-vertical, .slds-accordion, .slds-tree, .slds-split-view__list')) {
              return 'leftnav';
            }
            if (current.matches && current.matches('.slds-context-bar, header.slds-global-header, .forceHeader, .appName')) {
              return 'topbar';
            }
            const host = current.assignedSlot || (current.getRootNode && current.getRootNode().host);
            current = current.parentElement || host || null;
          }
          return 'main';
        }

        const results = [];
        const seenNodes = new Set();
        const dedupe = new Set();
        const queue = [];
        if (document.documentElement) {
          queue.push(document.documentElement);
        }

        while (queue.length) {
          const node = queue.shift();
          if (!node || seenNodes.has(node)) {
            continue;
          }
          seenNodes.add(node);

          if (node instanceof Element) {
            const role = (node.getAttribute('role') || '').trim().toLowerCase();
            let tag = node.tagName.toLowerCase();
            let typeAttr = (node.getAttribute('type') || '').trim().toLowerCase();
            if (tag === 'input' && !typeAttr) {
              typeAttr = 'text';
            }
            if (tag === 'select') {
              typeAttr = 'select';
            }
            if (tag === 'textarea') {
              typeAttr = 'textarea';
            }
            const dataTestId = node.getAttribute('data-testid') || (node.dataset && node.dataset.testid);

            const actionableRole = ACTIONABLE_ROLES.has(role);
            const actionableTag =
              ACTIONABLE_TAGS.has(tag) ||
              (tag === 'a' && node.hasAttribute('href')) ||
              (tag === 'input' && typeAttr !== 'hidden') ||
              node.isContentEditable ||
              dataTestId;

            if (actionableRole || actionableTag) {
              const name = accessibleName(node);
              const visible = isVisible(node);
              const disabled = node.disabled === true || node.getAttribute('aria-disabled') === 'true';
              const rect = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
              const bbox = rect
                ? {
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height
                  }
                : null;

              const dedupeKey = [role || '', name || '', tag, bbox ? Math.round(bbox.x) : 'na', bbox ? Math.round(bbox.y) : 'na'].join('|');
              if (!dedupe.has(dedupeKey)) {
                dedupe.add(dedupeKey);

                const label = labelText(node);
                const textCandidate = limit(node.innerText || node.textContent || '');
                const cssCandidate = candidateCss(node);
                const xpathCandidate = absoluteXPath(node);
                const region = guessRegion(node);

                const candidates = {};
                if (role && name) {
                  candidates.roleName = { role, name };
                }
                if (dataTestId) {
                  candidates.dataTestId = dataTestId;
                }
                if (label) {
                  candidates.label = label;
                }
                if (textCandidate) {
                  candidates.text = textCandidate;
                }
                if (cssCandidate) {
                  candidates.css = cssCandidate;
                }
                if (xpathCandidate) {
                  candidates.xpath = xpathCandidate;
                }

                const elementInfo = {
                  tag,
                  visible,
                  region: region || 'unknown'
                };

                if (node.id) {
                  elementInfo.id = node.id;
                }
                if (role) {
                  elementInfo.role = role;
                }
                if (name) {
                  elementInfo.name = name;
                }
                if (typeAttr) {
                  elementInfo.type = typeAttr;
                }
                if (disabled) {
                  elementInfo.disabled = true;
                }
                if (bbox) {
                  elementInfo.bbox = bbox;
                }
                if (Object.keys(candidates).length) {
                  elementInfo.candidates = candidates;
                }

                results.push(elementInfo);
              }
            }

            if (node.shadowRoot) {
              queue.push(node.shadowRoot);
            }
            if (node instanceof HTMLSlotElement && typeof node.assignedElements === 'function') {
              const assigned = node.assignedElements({ flatten: true });
              if (assigned && assigned.length) {
                queue.push(...assigned);
              }
            }
            queue.push(...Array.from(node.children || []));
          } else if (node instanceof ShadowRoot || node instanceof DocumentFragment || node instanceof Document) {
            queue.push(...Array.from(node.childNodes || []));
          }
        }

        results.sort((a, b) => {
          const ay = a.bbox ? a.bbox.y : Number.POSITIVE_INFINITY;
          const by = b.bbox ? b.bbox.y : Number.POSITIVE_INFINITY;
          if (ay !== by) {
            return ay - by;
          }
          const ax = a.bbox ? a.bbox.x : Number.POSITIVE_INFINITY;
          const bx = b.bbox ? b.bbox.x : Number.POSITIVE_INFINITY;
          return ax - bx;
        });

        return results;
      });
    } catch (err) {
      frameInfo.sameOrigin = false;
      frameInfo.elements = [];
    }

    map.frames.push(frameInfo);
  }

  map.frameCount = map.frames.length;
  return map;
}

main().catch(err => {
  console.error('Recorder failed:', err.message);
  process.exit(1);
});
