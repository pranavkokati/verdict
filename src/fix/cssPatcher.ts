import type { CDPSession, Page } from "playwright";

export interface PropertyFix {
  selector: string;
  property: string;
  value: string;
  /** The issue this fix addresses, carried through for reporting. */
  issueMessage: string;
}

export interface AppliedFix extends PropertyFix {
  method: "stylesheet-rule" | "inline-style";
}

export interface SkippedFix extends PropertyFix {
  reason: string;
}

export interface PatchResult {
  patchedHtml: string;
  applied: AppliedFix[];
  skipped: SkippedFix[];
}

/**
 * Applies a list of property fixes to a rendered page's *source HTML*, using
 * Chrome's own cascade engine (via CDP) to find the exact declaration that
 * determines each computed value, rather than re-implementing CSS cascade
 * resolution by hand.
 *
 * Two paths, both verified against the original source before ever touching it:
 *
 * 1. Stylesheet-rule edit: if the property is set by a matched CSS rule (a
 *    <style> block or external sheet), edit that rule's text via
 *    `CSS.setStyleTexts`, then pull the *whole updated stylesheet text* via
 *    `CSS.getStyleSheetText` and splice it in for the original stylesheet
 *    text -- but only if that original text appears verbatim in the source
 *    file first. If it doesn't (the source doesn't match what we rendered,
 *    e.g. a build step transformed it), the fix is skipped, not guessed at.
 *
 * 2. Inline-style fallback: if no rule declares the property (a pure
 *    user-agent default that happens to be off-grid/off-scale), set it via
 *    `DOM.setAttributeValue` on the live element and splice the single
 *    element's before/after serialization into the source the same
 *    verified way.
 *
 * Nothing is written by pattern-matching English text or guessing at byte
 * offsets. Every edit is confirmed present in the original source before
 * the patched HTML is returned.
 */
export async function applyPropertyFixes(
  page: Page,
  originalHtml: string,
  fixes: PropertyFix[],
): Promise<PatchResult> {
  const client = await page.context().newCDPSession(page);
  await client.send("DOM.enable");
  await client.send("CSS.enable");

  const { root } = await client.send("DOM.getDocument");

  let html = originalHtml;
  const applied: AppliedFix[] = [];
  const skipped: SkippedFix[] = [];

  for (const fix of fixes) {
    try {
      const result = await applyOneFix(client, root.nodeId, html, fix);
      if (result.ok) {
        html = result.html;
        applied.push({ ...fix, method: result.method });
      } else {
        skipped.push({ ...fix, reason: result.reason });
      }
    } catch (err) {
      skipped.push({
        ...fix,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { patchedHtml: html, applied, skipped };
}

async function applyOneFix(
  client: CDPSession,
  rootNodeId: number,
  currentHtml: string,
  fix: PropertyFix,
): Promise<{ ok: true; html: string; method: AppliedFix["method"] } | { ok: false; reason: string }> {
  const found = await client.send("DOM.querySelector", { nodeId: rootNodeId, selector: fix.selector }).catch(() => null);
  if (!found || !found.nodeId) {
    return { ok: false, reason: `Selector "${fix.selector}" no longer matches any element.` };
  }
  const nodeId = found.nodeId;

  const matched = await client.send("CSS.getMatchedStylesForNode", { nodeId });

  const inlineHit = declares(matched.inlineStyle, fix.property);
  if (inlineHit && matched.inlineStyle?.styleSheetId && matched.inlineStyle.range) {
    return patchViaStylesheetRule(client, currentHtml, matched.inlineStyle, fix, "inline-style");
  }

  const rules = matched.matchedCSSRules ?? [];
  for (let i = rules.length - 1; i >= 0; i--) {
    const style = rules[i].rule.style;
    if (declares(style, fix.property) && style.styleSheetId && style.range) {
      return patchViaStylesheetRule(client, currentHtml, style, fix, "stylesheet-rule");
    }
  }

  // Fall back: nothing declares this property explicitly (a UA default).
  // Set it as a new inline style and splice the single element's
  // before/after serialization.
  return patchViaInlineAttribute(client, currentHtml, nodeId, fix);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function declares(style: any, property: string): boolean {
  return !!style?.cssProperties?.some((p: { name: string; disabled?: boolean }) => p.name === property && !p.disabled);
}

async function patchViaStylesheetRule(
  client: CDPSession,
  currentHtml: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  style: any,
  fix: PropertyFix,
  method: AppliedFix["method"],
): Promise<{ ok: true; html: string; method: AppliedFix["method"] } | { ok: false; reason: string }> {
  const before = await client.send("CSS.getStyleSheetText", { styleSheetId: style.styleSheetId });
  if (!currentHtml.includes(before.text)) {
    return {
      ok: false,
      reason: "The matched stylesheet's current text doesn't appear verbatim in the source -- skipping rather than guessing at a byte offset.",
    };
  }

  const newRuleText = replaceOrAppendProperty(style.cssText, fix.property, fix.value);
  await client.send("CSS.setStyleTexts", {
    edits: [{ styleSheetId: style.styleSheetId, range: style.range, text: newRuleText }],
  });

  const after = await client.send("CSS.getStyleSheetText", { styleSheetId: style.styleSheetId });
  const patched = replaceLiteral(currentHtml, before.text, after.text);
  return { ok: true, html: patched, method };
}

async function patchViaInlineAttribute(
  client: CDPSession,
  currentHtml: string,
  nodeId: number,
  fix: PropertyFix,
): Promise<{ ok: true; html: string; method: AppliedFix["method"] } | { ok: false; reason: string }> {
  const before = await client.send("DOM.getOuterHTML", { nodeId });
  if (!currentHtml.includes(before.outerHTML)) {
    return {
      ok: false,
      reason: "The element's current serialization doesn't appear verbatim in the source -- skipping rather than guessing at a byte offset.",
    };
  }

  const attrs = await client.send("DOM.getAttributes", { nodeId });
  const styleIdx = attrs.attributes.findIndex((a: string, i: number) => i % 2 === 0 && a === "style");
  const existingStyle = styleIdx >= 0 ? attrs.attributes[styleIdx + 1] : "";
  const newStyle = replaceOrAppendProperty(existingStyle, fix.property, fix.value);

  await client.send("DOM.setAttributeValue", { nodeId, name: "style", value: newStyle });

  const after = await client.send("DOM.getOuterHTML", { nodeId });
  const patched = replaceLiteral(currentHtml, before.outerHTML, after.outerHTML);
  return { ok: true, html: patched, method: "inline-style" };
}

/**
 * Replaces the first literal occurrence of `search` in `haystack` with
 * `replacement`, treating `replacement` as an opaque literal string.
 *
 * `String.prototype.replace(search, replacement)` is NOT safe for this: when
 * `replacement` is a string (not a function), JS interprets `$&`, `` $` ``,
 * `$'`, `$$`, and `$<name>` sequences inside it as special patterns -- so a
 * patched stylesheet or element serialization that happens to contain a
 * literal `$$` (collapses to `$`) or `$&` (re-inserts the entire matched
 * text) would silently corrupt the written HTML. CSS `content` values,
 * custom properties, and arbitrary attribute/text content can all
 * legitimately contain `$`, so this isn't a contrived edge case. Passing a
 * replacer *function* instead of a string bypasses `$`-pattern
 * interpretation entirely, since a function's return value is spliced in
 * verbatim.
 */
function replaceLiteral(haystack: string, search: string, replacement: string): string {
  return haystack.replace(search, () => replacement);
}

function replaceOrAppendProperty(cssText: string, property: string, value: string): string {
  const re = new RegExp(`${escapeRegExp(property)}\\s*:\\s*[^;]+;?`, "i");
  if (re.test(cssText)) {
    // Function replacer, not a template string passed as the 2nd arg -- see
    // replaceLiteral's doc comment on why a literal `$` in `value` would
    // otherwise be misinterpreted as a regex replacement pattern.
    return cssText.replace(re, () => `${property}: ${value};`);
  }
  const trimmed = cssText.trim();
  const sep = trimmed.length > 0 && !trimmed.endsWith(";") ? "; " : trimmed.length > 0 ? " " : "";
  return `${trimmed}${sep}${property}: ${value};`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
