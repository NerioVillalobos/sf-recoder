const { execSync } = require('child_process');

const DEFAULT_RET_URL = '/lightning/page/home';

function getOrgInfo(alias) {
  if (!alias) {
    throw new Error('Missing required org alias. Pass --org <alias>.');
  }

  try {
    const result = execSync(`sf org display --json --target-org ${alias}`, {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const parsed = JSON.parse(result.toString());
    if (!parsed || !parsed.result) {
      throw new Error('Unexpected CLI response.');
    }
    const { instanceUrl, accessToken } = parsed.result;
    if (!instanceUrl || !accessToken) {
      throw new Error('Missing instanceUrl or accessToken in org info.');
    }
    return { instanceUrl, accessToken };
  } catch (err) {
    const message = err.stderr ? err.stderr.toString() : err.message;
    throw new Error(`Failed to fetch org info: ${message}`);
  }
}

function buildFrontdoorUrl(instanceUrl, accessToken, retURL = DEFAULT_RET_URL) {
  if (!instanceUrl || !accessToken) {
    throw new Error('instanceUrl and accessToken are required to build frontdoor URL.');
  }
  const encodedSid = encodeURIComponent(accessToken);
  const encodedRet = encodeURIComponent(retURL || DEFAULT_RET_URL);
  return `${instanceUrl}/secur/frontdoor.jsp?sid=${encodedSid}&retURL=${encodedRet}`;
}

module.exports = {
  getOrgInfo,
  buildFrontdoorUrl,
  DEFAULT_RET_URL
};
