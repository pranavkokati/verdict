/**
 * Verdict browser extension content script.
 *
 * This is a direct, dependency-free port of the same engine that powers the
 * CLI (src/render/browser.ts's extractInPage, src/checks/*.ts, and
 * src/score/aggregate.ts). It is not a lighter reimplementation: the
 * constants, formulas, and severity math below are copied line-for-line
 * from the TypeScript source, because the check modules and the extraction
 * function were already written with zero Node/Playwright dependency --
 * they only ever touched `document`, `window.getComputedStyle`, and plain
 * data. That's what makes running the exact same engine live in a tab,
 * instead of in a headless Chromium instance, a straight port rather than
 * a rewrite.
 *
 * Exposes window.__verdictRun(), which returns the same VerdictResult shape
 * (score, threshold, passed, checks[], issues[]) as `verdict check --json`,
 * minus the screenshot buffer (not meaningful outside a real render loop).
 */
(function () {
  if (window.__verdictRun) return; // already injected

  // ---------- extraction (ported from src/render/browser.ts extractInPage) ----------

  function cssSelector(el) {
    if (el.id) return "#" + el.id;
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      let part = node.tagName.toLowerCase();
      if (node.classList.length) {
        part += "." + Array.from(node.classList).slice(0, 2).join(".");
      }
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (sameTag.length > 1) {
          const idx = sameTag.indexOf(node) + 1;
          part += ":nth-of-type(" + idx + ")";
        }
      }
      parts.unshift(part);
      node = node.parentElement;
      depth++;
    }
    return parts.join(" > ");
  }

  function px(value) {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  }

  function extractFromLiveDocument() {
    const elements = [];
    const all = Array.from(document.body.querySelectorAll("*"));

    for (const el of all) {
      const cs = window.getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;

      const directText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => (n.textContent || "").trim())
        .join(" ")
        .trim();

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;

      elements.push({
        selector: cssSelector(el),
        tag: el.tagName.toLowerCase(),
        text: directText,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        style: {
          color: cs.color,
          backgroundColor: cs.backgroundColor,
          fontSize: px(cs.fontSize),
          fontWeight: px(cs.fontWeight) || (cs.fontWeight === "bold" ? 700 : 400),
          marginTop: px(cs.marginTop),
          marginRight: px(cs.marginRight),
          marginBottom: px(cs.marginBottom),
          marginLeft: px(cs.marginLeft),
          paddingTop: px(cs.paddingTop),
          paddingRight: px(cs.paddingRight),
          paddingBottom: px(cs.paddingBottom),
          paddingLeft: px(cs.paddingLeft),
          gap: px(cs.getPropertyValue("gap") || cs.getPropertyValue("row-gap")),
        },
      });
    }

    const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).map((h) => ({
      level: Number(h.tagName[1]),
      text: (h.textContent || "").trim().slice(0, 120),
      selector: cssSelector(h),
    }));

    const landmarks = Array.from(
      document.querySelectorAll('main, nav, header, footer, aside, [role="main"], [role="navigation"]'),
    ).map((l) => ({ tag: l.tagName.toLowerCase(), selector: cssSelector(l) }));

    const images = Array.from(document.querySelectorAll("img")).map((img) => ({
      selector: cssSelector(img),
      hasAlt: img.hasAttribute("alt"),
      alt: img.getAttribute("alt") || "",
    }));

    return { elements, headings, landmarks, images };
  }

  // ---------- color math (ported from src/checks/colorUtils.ts) ----------

  function parseColor(value) {
    const m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/i.exec(value);
    if (!m) return { r: 0, g: 0, b: 0, a: 1 };
    return {
      r: Number(m[1]),
      g: Number(m[2]),
      b: Number(m[3]),
      a: m[4] !== undefined ? Number(m[4]) : 1,
    };
  }

  function srgbToLinear(c) {
    const cs = c / 255;
    return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
  }

  function relativeLuminance(c) {
    return 0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b);
  }

  function contrastRatio(a, b) {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    const lighter = Math.max(la, lb);
    const darker = Math.min(la, lb);
    return (lighter + 0.05) / (darker + 0.05);
  }

  function compositeOver(fg, bg) {
    if (fg.a >= 1) return fg;
    return {
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1,
    };
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    const d = max - min;
    if (d !== 0) {
      s = d / (1 - Math.abs(2 * l - 1));
      switch (max) {
        case r: h = ((g - b) / d) % 6; break;
        case g: h = (b - r) / d + 2; break;
        default: h = (r - g) / d + 4;
      }
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h, s, l };
  }

  function hslToRgb(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255, a: 1 };
  }

  function toHex(c) {
    const h = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
    return "#" + h(c.r) + h(c.g) + h(c.b);
  }

  function suggestAccessibleColor(fg, bg, targetRatio) {
    const hsl = rgbToHsl(fg.r, fg.g, fg.b);
    const bgLum = relativeLuminance(bg);
    const darken = bgLum > 0.5;
    for (let steps = 0; steps <= 100; steps++) {
      const l2 = darken ? Math.max(0, hsl.l - steps / 100) : Math.min(1, hsl.l + steps / 100);
      const candidate = hslToRgb(hsl.h, hsl.s, l2);
      if (contrastRatio(candidate, bg) >= targetRatio) return toHex(candidate);
    }
    const black = { r: 0, g: 0, b: 0, a: 1 };
    const white = { r: 255, g: 255, b: 255, a: 1 };
    if (contrastRatio(black, bg) >= targetRatio) return toHex(black);
    if (contrastRatio(white, bg) >= targetRatio) return toHex(white);
    return null;
  }

  function isLargeText(fontSizePx, fontWeight) {
    if (fontSizePx >= 24) return true;
    if (fontSizePx >= 18.66 && fontWeight >= 700) return true;
    return false;
  }

  // ---------- checks (ported from src/checks/*.ts) ----------

  function truncate(s, n) {
    n = n || 40;
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  function contains(outer, inner) {
    return (
      outer.x <= inner.x + 0.5 &&
      outer.y <= inner.y + 0.5 &&
      outer.x + outer.width >= inner.x + inner.width - 0.5 &&
      outer.y + outer.height >= inner.y + inner.height - 0.5
    );
  }

  function findEffectiveBackground(el, all) {
    const candidates = all
      .filter((c) => contains(c.rect, el.rect) && parseColor(c.style.backgroundColor).a > 0)
      .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height);
    if (candidates.length > 0) return parseColor(candidates[0].style.backgroundColor);
    return parseColor("rgb(255,255,255)");
  }

  const AA_NORMAL = 4.5, AA_LARGE = 3.0, AAA_NORMAL = 7.0;

  function runContrastCheck(snapshot) {
    const issues = [];
    const textEls = snapshot.elements.filter((e) => e.text.length > 0);
    let checked = 0;

    for (const el of textEls) {
      const bg = findEffectiveBackground(el, snapshot.elements);
      if (!bg) continue;
      const fgColor = compositeOver(parseColor(el.style.color), bg);
      const ratio = contrastRatio(fgColor, bg);
      checked++;
      const large = isLargeText(el.style.fontSize, el.style.fontWeight);
      const threshold = large ? AA_LARGE : AA_NORMAL;
      if (ratio < threshold) {
        const fix = suggestAccessibleColor(fgColor, bg, threshold);
        issues.push({
          checkId: "contrast",
          severity: ratio < threshold * 0.7 ? "error" : "warning",
          message: 'Text "' + truncate(el.text) + '" has ' + ratio.toFixed(2) + ":1 contrast against its background, below the WCAG AA minimum for " + (large ? "large" : "normal") + " text.",
          selector: el.selector,
          measured: ratio.toFixed(2) + ":1",
          required: threshold.toFixed(1) + ":1",
          suggestedFix: fix
            ? "Change text color to " + fix + " (or darken/lighten equivalently) to reach " + threshold.toFixed(1) + ":1."
            : "Increase contrast between text and background to at least " + threshold.toFixed(1) + ":1.",
        });
      }
    }
    return {
      checkId: "contrast",
      name: "Color Contrast (WCAG 2.1)",
      passed: issues.filter((i) => i.severity === "error").length === 0,
      issues,
    };
  }

  const CANONICAL_STEPS = [10, 11, 12, 13, 14, 16, 18, 20, 22, 24, 28, 30, 32, 36, 40, 48, 56, 64, 72, 96];
  const TYPE_TOLERANCE_PX = 0.75;
  const MAX_DISTINCT_SIZES = 8;

  function round1(n) { return Math.round(n * 10) / 10; }

  function runTypeScaleCheck(snapshot) {
    const issues = [];
    const sizeToSelectors = new Map();
    for (const el of snapshot.elements) {
      if (!el.text) continue;
      const size = round1(el.style.fontSize);
      if (size <= 0) continue;
      if (!sizeToSelectors.has(size)) sizeToSelectors.set(size, []);
      sizeToSelectors.get(size).push(el.selector);
    }
    const distinctSizes = Array.from(sizeToSelectors.keys()).sort((a, b) => a - b);
    const offScale = distinctSizes.filter((s) => !CANONICAL_STEPS.some((step) => Math.abs(step - s) <= TYPE_TOLERANCE_PX));
    for (const size of offScale) {
      const nearest = CANONICAL_STEPS.reduce((a, b) => (Math.abs(b - size) < Math.abs(a - size) ? b : a));
      const selectors = sizeToSelectors.get(size);
      issues.push({
        checkId: "type-scale",
        severity: "warning",
        message: "Font-size " + size + "px (used on " + selectors.length + " element" + (selectors.length > 1 ? "s" : "") + ', e.g. "' + selectors[0] + '") doesn\'t land on a clean type-scale step -- looks like unintentional em/rem drift rather than a deliberate size.',
        selector: selectors[0],
        measured: size + "px",
        required: nearest + "px",
        suggestedFix: "Round to " + nearest + "px, the nearest step on a standard type scale.",
      });
    }
    if (distinctSizes.length > MAX_DISTINCT_SIZES) {
      issues.push({
        checkId: "type-scale",
        severity: "warning",
        message: distinctSizes.length + " distinct font sizes are in use (" + distinctSizes.join(", ") + "px). A coherent type system typically uses " + MAX_DISTINCT_SIZES + " or fewer.",
        measured: distinctSizes.length + " sizes",
        required: "<= " + MAX_DISTINCT_SIZES + " sizes",
        suggestedFix: "Consolidate onto a fixed scale (e.g. 12/14/16/18/24/32/48px) and map every text style to one of those steps.",
      });
    }
    return {
      checkId: "type-scale",
      name: "Type Scale Consistency",
      passed: offScale.length === 0 && distinctSizes.length <= MAX_DISTINCT_SIZES,
      issues,
    };
  }

  const CANDIDATE_BASE_UNITS = [8, 4];
  const SPACING_TOLERANCE_PX = 0.5;
  const MIN_SAMPLES = 6;

  function isMultiple(value, unit) {
    const remainder = value % unit;
    return remainder <= SPACING_TOLERANCE_PX || unit - remainder <= SPACING_TOLERANCE_PX;
  }

  function runSpacingGridCheck(snapshot) {
    const samples = [];
    for (const el of snapshot.elements) {
      const s = el.style;
      const props = [
        ["margin-top", s.marginTop], ["margin-right", s.marginRight],
        ["margin-bottom", s.marginBottom], ["margin-left", s.marginLeft],
        ["padding-top", s.paddingTop], ["padding-right", s.paddingRight],
        ["padding-bottom", s.paddingBottom], ["padding-left", s.paddingLeft],
        ["gap", s.gap],
      ];
      for (const [prop, value] of props) {
        if (value > 0) samples.push({ value, selector: el.selector, prop });
      }
    }
    if (samples.length < MIN_SAMPLES) {
      return { checkId: "spacing-grid", name: "Spacing Grid Consistency", passed: true, issues: [] };
    }
    let bestUnit = CANDIDATE_BASE_UNITS[0], bestFit = -1;
    for (const unit of CANDIDATE_BASE_UNITS) {
      const fit = samples.filter((s) => isMultiple(s.value, unit)).length / samples.length;
      if (fit > bestFit) { bestFit = fit; bestUnit = unit; }
    }
    const issues = [];
    const offGrid = samples.filter((s) => !isMultiple(s.value, bestUnit));
    const grouped = new Map();
    for (const s of offGrid) {
      const key = s.prop + ":" + s.value;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(s);
    }
    for (const [key, group] of grouped) {
      const parts = key.split(":");
      const prop = parts[0], value = Number(parts[1]);
      const nearest = Math.round(value / bestUnit) * bestUnit;
      issues.push({
        checkId: "spacing-grid",
        severity: group.length >= 3 ? "warning" : "info",
        message: prop + " of " + value + "px on " + group.length + " element" + (group.length > 1 ? "s" : "") + ' (e.g. "' + group[0].selector + '") isn\'t a multiple of the page\'s ' + bestUnit + "px spacing unit.",
        selector: group[0].selector,
        measured: value + "px",
        required: "multiple of " + bestUnit + "px (nearest: " + nearest + "px)",
        suggestedFix: "Change " + prop + " to " + nearest + "px to stay on the " + bestUnit + "px grid.",
      });
    }
    const gridAdherence = 1 - offGrid.length / samples.length;
    return {
      checkId: "spacing-grid",
      name: "Spacing Grid Consistency",
      passed: gridAdherence >= 0.85,
      issues,
    };
  }

  function runHierarchyCheck(snapshot) {
    const issues = [];
    const headings = snapshot.headings, landmarks = snapshot.landmarks, images = snapshot.images;
    const h1s = headings.filter((h) => h.level === 1);
    if (h1s.length === 0) {
      issues.push({ checkId: "hierarchy", severity: "error", message: "No <h1> found. Every page needs exactly one top-level heading.", suggestedFix: "Add a single <h1> that names the page's primary content." });
    } else if (h1s.length > 1) {
      issues.push({ checkId: "hierarchy", severity: "warning", message: h1s.length + " <h1> elements found (" + h1s.map((h) => '"' + h.text + '"').join(", ") + "). There should be exactly one.", selector: h1s[1].selector, suggestedFix: "Demote the extra <h1>s to <h2> or lower based on their place in the outline." });
    }
    let prevLevel = 0;
    for (const h of headings) {
      if (prevLevel > 0 && h.level > prevLevel + 1) {
        issues.push({ checkId: "hierarchy", severity: "warning", message: "Heading level jumps from h" + prevLevel + " to h" + h.level + ' ("' + h.text + '") -- skips h' + (prevLevel + 1) + ".", selector: h.selector, measured: "h" + prevLevel + " -> h" + h.level, required: "h" + prevLevel + " -> h" + (prevLevel + 1), suggestedFix: "Change to h" + (prevLevel + 1) + ", or insert the missing intermediate level." });
      }
      prevLevel = h.level;
    }
    const hasMain = landmarks.some((l) => l.tag === "main");
    if (!hasMain) {
      issues.push({ checkId: "hierarchy", severity: "warning", message: "No <main> landmark found.", suggestedFix: "Wrap the primary page content in a <main> element so assistive tech and skip-links can target it." });
    }
    const missingAlt = images.filter((i) => !i.hasAlt);
    for (const img of missingAlt) {
      issues.push({ checkId: "hierarchy", severity: "error", message: '<img> at "' + img.selector + '" has no alt attribute.', selector: img.selector, suggestedFix: 'Add a descriptive alt attribute, or alt="" if the image is purely decorative.' });
    }
    const errorCount = issues.filter((i) => i.severity === "error").length;
    return { checkId: "hierarchy", name: "Heading & Landmark Hierarchy", passed: errorCount === 0, issues };
  }

  // ---------- scoring (ported from src/score/aggregate.ts) ----------

  const SEVERITY_WEIGHT = { error: 8, warning: 3, info: 1 };

  function scoreSnapshot(target, snapshot, threshold) {
    threshold = threshold || 80;
    const checks = [runContrastCheck(snapshot), runTypeScaleCheck(snapshot), runSpacingGridCheck(snapshot), runHierarchyCheck(snapshot)];
    const allIssues = checks.reduce((acc, c) => acc.concat(c.issues), []);

    let deduction = 0;
    for (const check of checks) {
      const bySeverity = { error: 0, warning: 0, info: 0 };
      for (const issue of check.issues) bySeverity[issue.severity]++;
      for (const sev of ["error", "warning", "info"]) {
        const n = bySeverity[sev];
        if (n === 0) continue;
        let checkDeduction = 0;
        for (let i = 0; i < n; i++) checkDeduction += SEVERITY_WEIGHT[sev] / Math.sqrt(i + 1);
        deduction += Math.min(checkDeduction, 40);
      }
    }
    const score = Math.max(0, Math.round(100 - deduction));
    return {
      target,
      timestamp: new Date().toISOString(),
      score,
      passed: score >= threshold,
      threshold,
      checks,
      issues: allIssues,
    };
  }

  // ---------- public entry point ----------

  window.__verdictRun = function (threshold) {
    const snapshot = extractFromLiveDocument();
    return scoreSnapshot(location.href, snapshot, threshold || 80);
  };
})();
