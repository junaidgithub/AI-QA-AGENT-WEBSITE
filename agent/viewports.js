/**
 * Screen sizes the agent tests with. Desktop is the original 1280x720.
 * Mobile emulates a typical phone (390x844, touch, mobile user agent) so
 * responsive layouts and hamburger menus behave as they do on a phone.
 */

const DESKTOP = Object.freeze({
  name: "desktop",
  label: "Desktop",
  contextOptions: { viewport: { width: 1280, height: 720 } }
});

const MOBILE = Object.freeze({
  name: "mobile",
  label: "Mobile",
  contextOptions: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"
  }
});

const VIEWPORTS = { desktop: DESKTOP, mobile: MOBILE };

function viewportByName(name) {
  return VIEWPORTS[name] || DESKTOP;
}

module.exports = { DESKTOP, MOBILE, VIEWPORTS, viewportByName };
