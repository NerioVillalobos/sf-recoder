const DEFAULT_TIMEOUT = 20000;
const POLL_INTERVAL = 250;
const MAX_TEXT = 80;

function cssEscape(value) {
  return String(value).replace(/([\\"'\[\]#.:>+~*=^$|])/g, '\\$1');
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

async function waitForElement(page, attempt, timeout = DEFAULT_TIMEOUT) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const handle = await attempt();
    if (handle) {
      return handle;
    }
    await sleep(page, POLL_INTERVAL);
  }
  return null;
}

function withPageContext(page, fn, ...args) {
  return page.evaluateHandle(fn, ...args);
}

function normalize(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function limit(text) {
  const cleaned = normalize(text);
  if (!cleaned) {
    return '';
  }
  return cleaned.length > MAX_TEXT ? cleaned.slice(0, MAX_TEXT).trim() : cleaned;
}

async function findByDataTestId(page, value, timeout) {
  const selector = `[data-testid="${cssEscape(value)}"]`;
  return waitForElement(page, async () => page.$(selector), timeout);
}

async function findByCss(page, value, timeout) {
  return waitForElement(page, async () => page.$(value), timeout);
}

async function findByXpath(page, value, timeout) {
  return waitForElement(
    page,
    async () => {
      if (typeof page.$x === 'function') {
        const handles = await page.$x(value);
        if (handles.length > 0) {
          const [first, ...rest] = handles;
          await Promise.all(rest.map(h => h.dispose()));
          return first;
        }
        await Promise.all(handles.map(h => h.dispose()));
      }
      const handle = await page.evaluateHandle(xpath => {
        const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        return result.singleNodeValue || null;
      }, value);
      const element = handle.asElement();
      if (element) {
        return element;
      }
      await handle.dispose();
      return null;
    },
    timeout
  );
}

async function findByLabel(page, text, timeout) {
  const target = limit(text);
  return waitForElement(
    page,
    async () => {
      const handle = await withPageContext(
        page,
        labelText => {
          const normalize = value => (value || '').replace(/\s+/g, ' ').trim();
          const limit = value => {
            const cleaned = normalize(value);
            return cleaned.length > MAX_TEXT ? cleaned.slice(0, MAX_TEXT).trim() : cleaned;
          };

          window.CSS = window.CSS || {};
          if (typeof window.CSS.escape !== 'function') {
            window.CSS.escape = function (value) {
              return String(value).replace(/([\\"'\[\]#.:>+~*=^$|])/g, '\\$1');
            };
          }

          function queryAllDeep(root) {
            const results = [];
            const stack = [];
            if (root) {
              stack.push(root);
            }
            while (stack.length) {
              const node = stack.pop();
              if (!node) {
                continue;
              }
              if (node instanceof Element) {
                results.push(node);
                if (node.shadowRoot) {
                  stack.push(node.shadowRoot);
                }
              }
              const children = node instanceof Element || node instanceof DocumentFragment ? Array.from(node.children || []) : [];
              for (const child of children.reverse()) {
                stack.push(child);
              }
              if (node instanceof DocumentFragment) {
                stack.push(...node.childNodes);
              }
            }
            return results;
          }

          function accessibleName(el) {
            if (!(el instanceof Element)) {
              return '';
            }
            const aria = el.getAttribute('aria-label');
            if (aria) {
              return limit(aria);
            }
            const labelledby = el.getAttribute('aria-labelledby');
            if (labelledby) {
              const text = labelledby
                .split(/\s+/)
                .map(id => {
                  const ref = document.getElementById(id);
                  return ref ? ref.textContent : '';
                })
                .join(' ');
              const named = limit(text);
              if (named) {
                return named;
              }
            }
            const title = el.getAttribute('title');
            if (title) {
              return limit(title);
            }
            const placeholder = el.getAttribute('placeholder');
            if (placeholder) {
              return limit(placeholder);
            }
            return limit(el.innerText || el.textContent || '');
          }

          const targetLabel = normalize(labelText);
          if (!targetLabel) {
            return null;
          }

          for (const element of queryAllDeep(document.documentElement)) {
            if (!(element instanceof Element)) {
              continue;
            }

            const tag = element.tagName.toLowerCase();
            if (!['input', 'textarea', 'select'].includes(tag)) {
              continue;
            }

            if (normalize(accessibleName(element)) === targetLabel) {
              return element;
            }

            if (element.labels) {
              for (const label of Array.from(element.labels)) {
                if (normalize(label.textContent) === targetLabel) {
                  return element;
                }
              }
            }

            const id = element.getAttribute('id');
            if (id) {
              const direct = document.querySelector(`label[for="${CSS.escape(id)}"]`);
              if (direct && normalize(direct.textContent) === targetLabel) {
                return element;
              }
            }
          }

          return null;
        },
        target
      );
      const element = handle.asElement();
      if (element) {
        return element;
      }
      await handle.dispose();
      return null;
    },
    timeout
  );
}

async function findByText(page, selector, timeout) {
  const { text, match = 'equals' } = selector;
  const value = text || '';
  return waitForElement(
    page,
    async () => {
      const handle = await withPageContext(
        page,
        ({ searchText, matchMode }) => {
          const normalize = value => (value || '').replace(/\s+/g, ' ').trim();
          const toKey = value => normalize(value).toLowerCase();

          function visibleText(el) {
            if (!(el instanceof Element)) {
              return '';
            }
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
              return '';
            }
            if (el.getClientRects().length === 0) {
              return '';
            }
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
              acceptNode(node) {
                const parent = node.parentElement;
                if (!parent) {
                  return NodeFilter.FILTER_REJECT;
                }
                const parentStyle = window.getComputedStyle(parent);
                if (parentStyle.display === 'none' || parentStyle.visibility === 'hidden') {
                  return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
              }
            });
            let textContent = '';
            while (walker.nextNode()) {
              textContent += walker.currentNode.nodeValue;
            }
            return normalize(textContent || el.innerText || '');
          }

          function queryAllDeep(root) {
            const results = [];
            const stack = [];
            if (root) {
              stack.push(root);
            }
            while (stack.length) {
              const node = stack.pop();
              if (!node) {
                continue;
              }
              if (node instanceof Element) {
                results.push(node);
                if (node.shadowRoot) {
                  stack.push(node.shadowRoot);
                }
              }
              if (node instanceof DocumentFragment) {
                stack.push(...node.childNodes);
              }
              const children = node instanceof Element ? Array.from(node.children) : [];
              for (const child of children.reverse()) {
                stack.push(child);
              }
            }
            return results;
          }

          const target = normalize(searchText);
          const targetKey = toKey(searchText);
          const mode = matchMode || 'equals';
          let regex = null;
          if (mode === 'regex') {
            try {
              regex = new RegExp(searchText);
            } catch (err) {
              console.warn('Invalid regex selector:', err.message);
            }
          }

          let best = null;
          for (const element of queryAllDeep(document.documentElement)) {
            if (!(element instanceof Element)) {
              continue;
            }
            const textValue = visibleText(element);
            if (!textValue) {
              continue;
            }
            const normalized = normalize(textValue);
            const key = toKey(textValue);
            let matches = false;
            if (mode === 'equals') {
              matches = key === targetKey;
            } else if (mode === 'contains') {
              matches = key.includes(targetKey);
            } else if (mode === 'regex' && regex) {
              matches = regex.test(normalized);
            }
            if (!matches) {
              continue;
            }
            best = element;
            break;
          }

          return best;
        },
        { searchText: value, matchMode: match }
      );
      const element = handle.asElement();
      if (element) {
        return element;
      }
      await handle.dispose();
      return null;
    },
    timeout
  );
}

async function findByRole(page, selector, timeout) {
  const role = (selector.role || '').toLowerCase();
  const expectedName = limit(selector.name || '');
  return waitForElement(
    page,
    async () => {
      const handle = await withPageContext(
        page,
        ({ roleName, targetName }) => {
          const normalize = value => (value || '').replace(/\s+/g, ' ').trim();
          const limit = value => {
            const cleaned = normalize(value);
            return cleaned.length > MAX_TEXT ? cleaned.slice(0, MAX_TEXT).trim() : cleaned;
          };
          const toKey = value => normalize(value).toLowerCase();

          function visibleText(el) {
            if (!(el instanceof Element)) {
              return '';
            }
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
              return '';
            }
            if (el.getClientRects().length === 0) {
              return '';
            }
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
              acceptNode(node) {
                const parent = node.parentElement;
                if (!parent) {
                  return NodeFilter.FILTER_REJECT;
                }
                const parentStyle = window.getComputedStyle(parent);
                if (parentStyle.display === 'none' || parentStyle.visibility === 'hidden') {
                  return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
              }
            });
            let textContent = '';
            while (walker.nextNode()) {
              textContent += walker.currentNode.nodeValue;
            }
            return normalize(textContent || el.innerText || '');
          }

          function accessibleName(el) {
            if (!(el instanceof Element)) {
              return '';
            }
            const aria = el.getAttribute('aria-label');
            if (aria) {
              return limit(aria);
            }
            const labelledby = el.getAttribute('aria-labelledby');
            if (labelledby) {
              const text = labelledby
                .split(/\s+/)
                .map(id => {
                  const ref = document.getElementById(id);
                  return ref ? ref.textContent : '';
                })
                .join(' ');
              const labelled = limit(text);
              if (labelled) {
                return labelled;
              }
            }
            const title = el.getAttribute('title');
            if (title) {
              return limit(title);
            }
            const visible = visibleText(el);
            if (visible) {
              return limit(visible);
            }
            const placeholder = el.getAttribute('placeholder');
            if (placeholder) {
              return limit(placeholder);
            }
            return '';
          }

          function queryAllDeep(root) {
            const results = [];
            const stack = [];
            if (root) {
              stack.push(root);
            }
            while (stack.length) {
              const node = stack.pop();
              if (!node) {
                continue;
              }
              if (node instanceof Element) {
                results.push(node);
                if (node.shadowRoot) {
                  stack.push(node.shadowRoot);
                }
              }
              if (node instanceof DocumentFragment) {
                stack.push(...node.childNodes);
              }
              const children = node instanceof Element ? Array.from(node.children) : [];
              for (const child of children.reverse()) {
                stack.push(child);
              }
            }
            return results;
          }

          function candidateNames(el, roleLower, targetKey) {
            const keys = new Set();
            const push = value => {
              const key = toKey(value);
              if (key) {
                keys.add(key);
              }
            };

            push(accessibleName(el));
            push(el.getAttribute('aria-label'));
            push(el.getAttribute('title'));
            push(el.getAttribute('data-label'));
            push(el.getAttribute('data-name'));
            push(el.getAttribute('data-value'));
            push(el.getAttribute('data-target-selection-name'));
            push(el.getAttribute('placeholder'));

            const labelledBy = el.getAttribute('aria-labelledby');
            if (labelledBy) {
              for (const id of labelledBy.split(/\s+/)) {
                const ref = id ? document.getElementById(id) : null;
                if (ref) {
                  push(ref.textContent);
                }
              }
            }

            const parent = el.parentElement;
            if (parent) {
              push(accessibleName(parent));
              if (parent.getAttribute) {
                push(parent.getAttribute('aria-label'));
                push(parent.getAttribute('title'));
                push(parent.getAttribute('data-label'));
              }
              push(parent.innerText || parent.textContent);
            }

            const previous = el.previousElementSibling;
            if (previous) {
              push(accessibleName(previous));
              push(previous.innerText || previous.textContent);
            }

            const next = el.nextElementSibling;
            if (next) {
              push(accessibleName(next));
              push(next.innerText || next.textContent);
            }

            if (roleLower === 'button' && targetKey === 'app launcher') {
              const container = el.closest('.appLauncher, .app-launcher, .slds-app-launcher, .slds-icon-waffle, [data-app-launcher]');
              if (container) {
                push(accessibleName(container));
                if (container.getAttribute) {
                  push(container.getAttribute('title'));
                  push(container.getAttribute('aria-label'));
                }
                push(container.innerText || container.textContent);
              }
            }

            return Array.from(keys.values());
          }

          const roleLower = (roleName || '').toLowerCase();
          const targetKey = toKey(targetName);
          let best = null;
          let bestArea = Infinity;

          for (const element of queryAllDeep(document.documentElement)) {
            if (!(element instanceof Element)) {
              continue;
            }
            const attrRole = (element.getAttribute('role') || '').toLowerCase();
            if (attrRole !== roleLower) {
              continue;
            }
            const names = candidateNames(element, roleLower, targetKey);
            const directMatch = names.some(candidate => candidate === targetKey);
            const allowContains = roleLower === 'button' && targetKey === 'app launcher';
            const containsMatch = allowContains && names.some(candidate => candidate.includes(targetKey));
            if (!directMatch && !containsMatch) {
              continue;
            }
            const rect = element.getBoundingClientRect();
            const area = rect && rect.width && rect.height ? rect.width * rect.height : Number.MAX_VALUE;

            if (allowContains && !directMatch) {
              const titleKey = toKey(element.getAttribute('title'));
              const ariaKey = toKey(element.getAttribute('aria-label'));
              if (titleKey === targetKey || ariaKey === targetKey) {
                best = element;
                bestArea = area;
                break;
              }
            }

            if (!best || area < bestArea) {
              best = element;
              bestArea = area;
            }
          }

          return best;
        },
        { roleName: role, targetName: expectedName }
      );
      const element = handle.asElement();
      if (element) {
        return element;
      }
      await handle.dispose();
      return null;
    },
    timeout
  );
}

async function resolveHandle(page, selector, options = {}) {
  if (!selector || typeof selector !== 'object') {
    throw new Error('Selector is required.');
  }
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  let handle = null;

  switch (selector.type) {
    case 'dataTestId':
      handle = await findByDataTestId(page, selector.value, timeout);
      break;
    case 'css':
      handle = await findByCss(page, selector.value, timeout);
      break;
    case 'xpath':
      handle = await findByXpath(page, selector.value, timeout);
      break;
    case 'text':
      handle = await findByText(page, selector, timeout);
      break;
    case 'label':
      handle = await findByLabel(page, selector.text, timeout);
      break;
    case 'role':
      handle = await findByRole(page, selector, timeout);
      break;
    default:
      throw new Error(`Unsupported selector type: ${selector.type}`);
  }

  if (!handle) {
    throw new Error(`Could not resolve selector (${selector.type}).`);
  }

  return handle;
}

module.exports = {
  resolveHandle
};
