/**
 * Browser-side helpers shared by discovery and execution.
 *
 * Playwright serialises functions passed to page.evaluate(), so they cannot
 * reference Node-side code. Instead this source is evaluated once per page
 * and exposes window.__qa for later evaluate() calls.
 */

const DOM_HELPERS_SOURCE = String.raw`
(() => {
  if (window.__qa) return;

  function clean(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  function hasRenderedBox(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return true;
    // Inline links that only wrap block/replaced content report an empty box.
    for (const child of el.querySelectorAll("*")) {
      const childRect = child.getBoundingClientRect();
      if (childRect.width > 0 && childRect.height > 0) return true;
    }
    return false;
  }

  // Returns null when the element is visible to a user, otherwise a short reason.
  function hiddenReason(el) {
    if (!el || !el.isConnected) return "not attached to the page";

    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none") {
        return node === el ? "display:none" : "inside a container with display:none";
      }
      if (node !== el && node.tagName === "DETAILS" && !node.open && !el.closest("summary")) {
        return "inside a collapsed <details> element";
      }
      if (parseFloat(style.opacity) === 0) {
        return node === el ? "opacity:0" : "inside a container with opacity:0";
      }
    }

    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.visibility === "collapse") return "visibility:hidden";
    if (!hasRenderedBox(el)) return "zero size (no rendered box)";

    const rect = el.getBoundingClientRect();
    const pageWidth = Math.max(document.documentElement.scrollWidth, window.innerWidth);
    if (rect.right <= 0 || rect.bottom <= -window.scrollY || rect.left >= pageWidth) {
      return "positioned off-screen";
    }

    const clip = style.clip || "";
    if (/rect\(\s*0(px)?[ ,]+0(px)?[ ,]+0(px)?[ ,]+0(px)?\s*\)/.test(clip) && rect.width <= 2 && rect.height <= 2) {
      return "visually hidden (clipped to 1px)";
    }

    return null;
  }

  function cssPath(el) {
    if (!(el instanceof Element)) return null;
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
      if (node.id && document.querySelectorAll("#" + CSS.escape(node.id)).length === 1) {
        parts.unshift("#" + CSS.escape(node.id));
        break;
      }
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      const sameTag = [...parent.children].filter(child => child.tagName === node.tagName);
      parts.unshift(sameTag.length > 1 ? tag + ":nth-of-type(" + (sameTag.indexOf(node) + 1) + ")" : tag);
    }
    return parts.join(" > ");
  }

  function labelText(el) {
    if (el.labels && el.labels.length) {
      // Wrapping labels also contain the control (e.g. a select's options); drop it.
      const copy = el.labels[0].cloneNode(true);
      copy.querySelectorAll("input, select, textarea, button").forEach(node => node.remove());
      const fromLabel = clean(copy.textContent);
      if (fromLabel) return fromLabel;
    }
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map(id => document.getElementById(id)).filter(Boolean)
        .map(node => clean(node.innerText || node.textContent)).join(" ");
      if (text) return text;
    }
    return clean(el.getAttribute("aria-label"));
  }

  // Accessible-ish name: visible text, then ARIA/title, then image alt text.
  function elementName(el) {
    const text = clean(el.innerText || "") || clean(el.textContent || "");
    const aria = clean(el.getAttribute("aria-label")) || labelText(el);
    // Symbol-only text such as "›" or "×" is less descriptive than an ARIA label.
    if (text && (/[\p{L}\p{N}]/u.test(text) || !aria)) return text;
    if (aria) return aria;
    const title = clean(el.getAttribute("title"));
    if (title) return title;
    const img = el.querySelector("img[alt], [role='img'][aria-label], svg title");
    if (img) return clean(img.getAttribute("alt") || img.getAttribute("aria-label") || img.textContent);
    if (el.tagName === "INPUT") return clean(el.value);
    return "";
  }

  function formIndexOf(el) {
    const form = el.form || el.closest("form");
    return form ? [...document.forms].indexOf(form) : -1;
  }

  window.__qa = { clean, hiddenReason, cssPath, labelText, elementName, formIndexOf };
})();
`;

async function ensureDomHelpers(page) {
  await page.evaluate(DOM_HELPERS_SOURCE);
}

module.exports = { DOM_HELPERS_SOURCE, ensureDomHelpers };
