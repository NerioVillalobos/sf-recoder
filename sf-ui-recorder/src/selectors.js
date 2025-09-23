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
            let matches = false;
            if (mode === 'equals') {
              matches = normalized === target;
            } else if (mode === 'contains') {
              matches = normalized.includes(target);
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

          function candidateNames(el) {
            const names = [];
            const base = accessibleName(el);
            if (base) {
              names.push(base);
            }
            if (!base) {
              const container = el.closest('[data-label], [data-name], [data-value], [aria-label], [title]');
              if (container) {
                const fromContainer = accessibleName(container) || visibleText(container);
                if (fromContainer) {
                  names.push(limit(fromContainer));
                }
              }
              const parent = el.parentElement;
              if (parent) {
                const fromParent = accessibleName(parent) || visibleText(parent);
                if (fromParent) {
                  names.push(limit(fromParent));
                }
              }
              const sibling = el.nextElementSibling;
              if (sibling) {
                const fromSibling = accessibleName(sibling) || visibleText(sibling);
                if (fromSibling) {
                  names.push(limit(fromSibling));
                }
              }
            }
            return names.map(normalize).filter(Boolean);
          }

          const roleLower = (roleName || '').toLowerCase();
          const target = normalize(targetName);
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
            const names = candidateNames(element);
            if (!names.some(candidate => candidate === target)) {
              continue;
            }
            const rect = element.getBoundingClientRect();
            const area = rect && rect.width && rect.height ? rect.width * rect.height : Number.MAX_VALUE;
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
