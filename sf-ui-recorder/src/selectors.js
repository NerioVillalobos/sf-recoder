const DEFAULT_TIMEOUT = 20000;
const POLL_INTERVAL = 250;

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

function cssEscape(value) {
  return String(value).replace(/([\\\"'\[\]#.:>+~*=^$|])/g, '\\$1');
}

function xpathLiteral(value) {
  if (!value.includes("'")) {
    return `'${value}'`;
  }
  const parts = value.split("'").map(part => `'${part}'`);
  return `concat(${parts.join(", '\'', ")})`;
}

async function waitForHandle(page, getter, timeout = DEFAULT_TIMEOUT) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const handle = await getter();
    if (handle) {
      return handle;
    }
    await sleep(page, POLL_INTERVAL);
  }
  return null;
}

async function queryXPath(page, expression) {
  if (typeof page.$x === 'function') {
    const handles = await page.$x(expression);
    if (handles.length > 0) {
      return handles[0];
    }
  }

  const handle = await page.evaluateHandle(xpath => {
    const result = document.evaluate(
      xpath,
      document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null
    );
    return result.singleNodeValue || null;
  }, expression);

  const element = handle.asElement();
  if (element) {
    return element;
  }
  await handle.dispose();
  return null;
}

async function queryShadowByText(page, value, exact) {
  return page.evaluateHandle(
    (search, exactMatch) => {
      const normalize = text => (text || '').replace(/\s+/g, ' ').trim();

      const queue = [];
      if (document.documentElement) {
        queue.push(document.documentElement);
      }

      while (queue.length) {
        const node = queue.shift();
        if (!(node instanceof Element)) {
          continue;
        }

        const text = normalize(node.innerText || node.textContent);
        if (text) {
          if (exactMatch ? text === search : text.includes(search)) {
            return node;
          }
        }

        if (node.shadowRoot) {
          queue.push(...node.shadowRoot.children);
          const slots = Array.from(node.shadowRoot.querySelectorAll('slot'));
          for (const slot of slots) {
            const assigned = slot.assignedElements ? slot.assignedElements() : [];
            queue.push(...assigned);
          }
        }

        queue.push(...node.children);
      }

      return null;
    },
    value,
    exact
  );
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

const TEXT_SUFFIX_PATTERNS = [
  /Opens in a new tab/i,
  /Opens in new tab/i,
  /Opens in a new window/i,
  /Opens in new window/i,
  /Press Enter to open/i,
  /Press Space to open/i,
  /Press space to activate/i,
  /Press enter to activate/i
];

function buildTextVariants(value) {
  const variants = new Set();
  const normalized = normalizeText(value);
  if (normalized) {
    variants.add(normalized);

    for (const pattern of TEXT_SUFFIX_PATTERNS) {
      const matchIndex = normalized.search(pattern);
      if (matchIndex > 0) {
        const shortened = normalizeText(normalized.slice(0, matchIndex));
        if (shortened) {
          variants.add(shortened);
        }
      }
    }

    const clearIndex = normalized.search(/\bClear All results for\b/i);
    if (clearIndex > 0) {
      const beforeClear = normalizeText(normalized.slice(0, clearIndex));
      if (beforeClear) {
        variants.add(beforeClear);
      }
    }

    const appsIndex = normalized.indexOf(' Apps ');
    if (appsIndex > 0) {
      const beforeApps = normalizeText(normalized.slice(0, appsIndex));
      if (beforeApps) {
        variants.add(beforeApps);
      }
    }

    const hyphenIndex = normalized.indexOf(' - ');
    if (hyphenIndex > 0) {
      const beforeHyphen = normalizeText(normalized.slice(0, hyphenIndex));
      if (beforeHyphen) {
        variants.add(beforeHyphen);
      }
    }

    const colonIndex = normalized.indexOf(':');
    if (colonIndex > 0) {
      const beforeColon = normalizeText(normalized.slice(0, colonIndex));
      if (beforeColon) {
        variants.add(beforeColon);
      }
    }

    const sentenceMatch = normalized.match(/[^.!?]+[.!?…]/);
    if (sentenceMatch) {
      const firstSentence = normalizeText(sentenceMatch[0]);
      if (firstSentence) {
        variants.add(firstSentence);
      }
    }

    if (normalized.length > 80) {
      const words = normalized.split(' ').filter(Boolean);
      const wordWindows = [8, 5, 3, 2];
      for (const count of wordWindows) {
        if (words.length >= count) {
          const chunk = normalizeText(words.slice(0, count).join(' '));
          if (chunk) {
            variants.add(chunk);
          }
        }
      }
    }

    if (/\bApp Launcher\b/i.test(normalized)) {
      variants.add('App Launcher');
    }
  }

  return Array.from(variants);
}

async function byDataTestId(page, value, timeout) {
  return waitForHandle(page, async () => {
    const selector = `[data-testid="${cssEscape(value)}"]`;
    const handle = await page.$(selector);
    return handle;
  }, timeout);
}

async function byLabel(page, value, timeout) {
  return waitForHandle(page, async () => {
    const handle = await page.evaluateHandle(labelText => {
      const normalize = text => text ? text.replace(/\s+/g, ' ').trim() : '';
      const search = normalize(labelText);
      const labels = Array.from(document.querySelectorAll('label'));
      for (const label of labels) {
        if (normalize(label.textContent) === search) {
          if (label.control) {
            return label.control;
          }
          const forId = label.getAttribute('for');
          if (forId) {
            const control = document.getElementById(forId);
            if (control) {
              return control;
            }
          }
          const input = label.querySelector('input,textarea,select');
          if (input) {
            return input;
          }
        }
      }
      const aria = Array.from(document.querySelectorAll('[aria-label]'))
        .find(el => normalize(el.getAttribute('aria-label')) === search);
      return aria || null;
    }, value);
    const element = handle.asElement();
    if (element) {
      return element;
    }
    await handle.dispose();
    return null;
  }, timeout);
}

async function byText(page, value, timeout) {
  const variants = buildTextVariants(value);

  return waitForHandle(page, async () => {
    for (const variant of variants) {
      const literal = xpathLiteral(variant);
      const exactQueries = [
        `//button[normalize-space()=${literal}]`,
        `//a[normalize-space()=${literal}]`,
        `//span[normalize-space()=${literal}]`,
        `//div[normalize-space()=${literal}]`,
        `//lightning-formatted-text[normalize-space()=${literal}]`,
        `//*[@placeholder and normalize-space(@placeholder)=${literal}]`,
        `//*[@aria-label and normalize-space(@aria-label)=${literal}]`
      ];

      for (const query of exactQueries) {
        const handle = await queryXPath(page, query);
        if (handle) {
          return handle;
        }
      }
    }

    for (const variant of variants) {
      const literal = xpathLiteral(variant);
      const containsQueries = [
        `//button[contains(normalize-space(), ${literal})]`,
        `//a[contains(normalize-space(), ${literal})]`,
        `//span[contains(normalize-space(), ${literal})]`,
        `//div[contains(normalize-space(), ${literal})]`,
        `//lightning-formatted-text[contains(normalize-space(), ${literal})]`,
        `//*[@placeholder and contains(normalize-space(@placeholder), ${literal})]`,
        `//*[@aria-label and contains(normalize-space(@aria-label), ${literal})]`
      ];

      for (const query of containsQueries) {
        const handle = await queryXPath(page, query);
        if (handle) {
          return handle;
        }
      }
    }

    for (const variant of variants) {
      const exactHandle = await queryShadowByText(page, variant, true);
      const exactElement = exactHandle.asElement();
      if (exactElement) {
        return exactElement;
      }
      await exactHandle.dispose();
    }

    for (const variant of variants) {
      const containsHandle = await queryShadowByText(page, variant, false);
      const containsElement = containsHandle.asElement();
      if (containsElement) {
        return containsElement;
      }
      await containsHandle.dispose();
    }

    return null;
  }, timeout);
}

async function byCss(page, value, timeout) {
  return waitForHandle(page, async () => page.$(value), timeout);
}

async function byXpath(page, value, timeout) {
  return waitForHandle(page, async () => queryXPath(page, value), timeout);
}

async function byRole(page, value, timeout) {
  return waitForHandle(page, async () => {
    const selector = `[role="${cssEscape(value)}"]`;
    const handle = await page.$(selector);
    return handle;
  }, timeout);
}

async function resolveHandle(page, selector, options = {}) {
  if (!selector || !selector.type || !selector.value) {
    throw new Error('Invalid selector provided.');
  }

  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const value = selector.value;
  let handle = null;

  switch (selector.type) {
    case 'dataTestId':
      handle = await byDataTestId(page, value, timeout);
      break;
    case 'label':
      handle = await byLabel(page, value, timeout);
      break;
    case 'text':
      handle = await byText(page, value, timeout);
      break;
    case 'css':
      handle = await byCss(page, value, timeout);
      break;
    case 'xpath':
      handle = await byXpath(page, value, timeout);
      break;
    case 'role':
      handle = await byRole(page, value, timeout);
      break;
    default:
      throw new Error(`Unsupported selector type: ${selector.type}`);
  }

  if (!handle) {
    throw new Error(`Could not resolve selector (${selector.type}: ${selector.value}) within ${timeout}ms.`);
  }

  return handle;
}

module.exports = {
  resolveHandle
};
