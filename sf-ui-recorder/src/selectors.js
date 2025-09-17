const DEFAULT_TIMEOUT = 10000;
const POLL_INTERVAL = 250;

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
    await page.waitForTimeout(POLL_INTERVAL);
  }
  return null;
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
  const literal = xpathLiteral(value.trim());
  const queries = [
    `//button[normalize-space()=${literal}]`,
    `//a[normalize-space()=${literal}]`,
    `//span[normalize-space()=${literal}]`,
    `//div[normalize-space()=${literal}]`,
    `//lightning-formatted-text[normalize-space()=${literal}]`
  ];

  return waitForHandle(page, async () => {
    for (const query of queries) {
      const handles = await page.$x(query);
      if (handles.length > 0) {
        return handles[0];
      }
    }
    return null;
  }, timeout);
}

async function byCss(page, value, timeout) {
  return waitForHandle(page, async () => page.$(value), timeout);
}

async function byXpath(page, value, timeout) {
  return waitForHandle(page, async () => {
    const handles = await page.$x(value);
    return handles[0] || null;
  }, timeout);
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

  const timeout = options.timeout || DEFAULT_TIMEOUT;
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
