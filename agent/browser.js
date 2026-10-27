const { chromium } = require("playwright");
const { DESKTOP } = require("./viewports");

const VIEWPORT = Object.freeze({ width: 1280, height: 720 });

/**
 * Launch Chromium. PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH lets you point at a
 * system Chromium/Chrome (useful in locked-down environments).
 */
function launchBrowser() {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  return chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath, args: ["--no-sandbox"] } : {})
  });
}

function newQaContext(browser, viewport = DESKTOP) {
  return browser.newContext({
    ...viewport.contextOptions,
    // Service workers can bypass request interception; block them so the
    // safety guard below sees every request.
    serviceWorkers: "block"
  });
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Safety guard: once the page has loaded, abort every state-changing request
 * (POST, PUT, PATCH, DELETE...). This guarantees the agent cannot submit a
 * form, send a message or trigger a purchase even if a click unexpectedly
 * fires one. Set QA_ALLOW_MUTATING_REQUESTS=true only for sites you own.
 */
async function installMutationGuard(context) {
  const guard = { enabled: true, blocked: [], blockNavigationOf: null, blockedNavigations: [] };
  if (String(process.env.QA_ALLOW_MUTATING_REQUESTS).toLowerCase() === "true") {
    guard.enabled = false;
    return guard;
  }

  await context.route("**/*", route => {
    const request = route.request();
    if (guard.blockNavigationOf && request.isNavigationRequest()) {
      let isMainFrame = false;
      try { isMainFrame = request.frame() === guard.blockNavigationOf.mainFrame(); } catch {}
      if (isMainFrame) {
        guard.blockedNavigations.push({ method: request.method(), url: request.url() });
        return route.abort("blockedbyclient");
      }
    }
    if (SAFE_METHODS.has(request.method().toUpperCase())) return route.continue();
    guard.blocked.push({ method: request.method(), url: request.url() });
    return route.abort("blockedbyclient");
  });

  return guard;
}

module.exports = { launchBrowser, newQaContext, installMutationGuard, VIEWPORT };
