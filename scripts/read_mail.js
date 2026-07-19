#!/usr/bin/env node
/**
 * read_mail.js - Read the currently-opened Feishu mail body.
 *
 * Usage:
 *   node read_mail.js [--max 30000]
 *
 * Strategy (v2 - wrapper-anchored, no feed-list pollution):
 *
 *   Previous approach: take the LAST occurrence of the subject in the full
 *   tab text and print everything after it. This broke when the feed-list
 *   preview order placed some feed items after the detail panel in DOM
 *   order, leaking other mails into the output.
 *
 *   New approach: the detail panel renders each mail in a dedicated
 *   `[class*='MessageItem-module__wrapper']` element (one per reply in a
 *   thread, newest first, including collapsed history). We:
 *
 *     1. Query the subject from `[class*='threadHeaderTitleText']`.
 *     2. Query all MessageItem wrappers -> get each mail''s first ~40 chars
 *        (sender + date) as a unique anchor. (query truncates element text
 *        at 240 chars, so we only use the wrapper text for the anchor.)
 *     3. Read the full tab text (uncapped by query).
 *     4. For each wrapper anchor, find its position in the full text, then
 *        slice from there up to the next wrapper anchor (or the end of the
 *        detail panel). Concatenate -> complete thread body, no feed leak.
 *
 *   If no wrappers are found (edge case: mail open but panel not mounted
 *   yet), fall back to a subject-anchored slice of the full text.
 */

const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");


// Load local config (git-ignored). Falls back to template if local copy missing.
const CONFIG_PATH = fs.existsSync(path.join(__dirname, "config.local.js"))
  ? path.join(__dirname, "config.local.js")
  : path.join(__dirname, "config.template.js");
const { BRIDGE_DIR, MAIL_HOST } = require(CONFIG_PATH);
const CLIENT = path.join(BRIDGE_DIR, "bridge", "edge-client.js");
function findMailTabId() {
  const out = execFileSync("node", [CLIENT, "tabs"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const lines = out.split(/\r?\n/);
  let currentId = null;
  for (const line of lines) {
    const m = line.match(/^[\s*]*(\d+)\s+(.*)$/);
    if (m) {
      currentId = m[1];
      const title = m[2];
      if (title.includes("飞书邮箱") || title.toLowerCase().includes("feishu mail")) {
        return currentId;
      }
    } else {
      const urlMatch = line.match(/^\s*(https?:\S+)/);
      if (urlMatch && urlMatch[1].includes(`${MAIL_HOST}/mail`)) {
        return currentId;
      }
    }
  }
  return null;
}

function querySelector(tabId, selector) {
  const out = execFileSync(
    "node",
    [CLIENT, "query", selector, "--tab", String(tabId), "--json"],
    { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, windowsHide: true }
  );
  return JSON.parse(out);
}

function readTab(tabId, max) {
  return execFileSync(
    "node",
    [CLIENT, "read", "--tab", String(tabId), "--max", String(max)],
    { encoding: "utf8", maxBuffer: 50 * 1024 * 1024, windowsHide: true }
  );
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalize(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function buildFuzzyRegex(text) {
  // Allow arbitrary whitespace (incl. newlines) between non-space tokens.
  // read may line-wrap differently than query.
  const tokens = normalize(text).split(" ").filter(Boolean).map(escapeRegex);
  if (tokens.length === 0) return null;
  return new RegExp(tokens.join("\\s*"));
}

function findFirstMatch(re, text, fromIndex) {
  const flags = new RegExp(re.source, "g");
  flags.lastIndex = fromIndex || 0;
  const m = flags.exec(text);
  if (m) return m.index;
  return -1;
}

// Strip trailing action-button labels and hidden-element artifacts that the
// Feishu detail panel renders after each message body.
function stripTrailingButtons(s) {
  // Remove a trailing block of "回复 / 回复全部 / 转发" (newline-separated
  // or space-separated), plus stray "rangeDom" lines.
  let cleaned = s;
  // Drop "rangeDom" lines entirely (hidden range-marker element text).
  cleaned = cleaned.replace(/\brangeDom\b\s*/g, "");
  // Collapse trailing reply/forward button cluster.
  cleaned = cleaned.replace(/(\n\s*(回复|回复全部|转发)\s*)+\s*$/m, "");
  return cleaned.trimEnd();
}

function cleanText(s) {
  return stripTrailingButtons(
    s
      .replace(/\r/g, "")
      .split("\n")
      .map((l) => l.trimEnd())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

// Try to trim trailing feed-list noise from the last message slice.
// The detail panel ends before the left-nav "全部邮件 / 全标已读" toolbar
// or before the next feed list preview. We look for the first feed-list
// signature and cut there.
function trimTrailingFeedNoise(text) {
  // Signatures observed at the boundary between detail panel and feed list.
  const signatures = [
    /\n全部邮件\b/,
    /\n全标已读\b/,
    /\n收件箱\b/,        // left-nav folder name re-appears below the panel
    /\n已发送\b/,
    /\n草稿箱\b/,
    /\n已加旗标\b/,
    /\n已归档\b/,
    /\n已删除\b/,
    /\n垃圾邮件\b/,
  ];
  let cut = text.length;
  for (const re of signatures) {
    const m = text.match(re);
    if (m && m.index < cut) cut = m.index;
  }
  return text.slice(0, cut).trimEnd();
}

function main() {
  const args = process.argv.slice(2);
  let max = 30000;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--max" && args[i + 1]) {
      max = parseInt(args[i + 1], 10);
      i++;
    }
  }

  const tabId = findMailTabId();
  if (!tabId) {
    console.error("ERROR: No Feishu Mail tab found.");
    process.exit(1);
  }

  // Step 1: subject
  let subject = "";
  try {
    const q = querySelector(tabId, "[class*='threadHeaderTitleText']");
    if (q.elements && q.elements.length > 0) {
      subject = (q.elements[0].text || "").trim();
    }
  } catch (e) {
    // ignore
  }
  if (!subject) {
    console.error("ERROR: No active mail subject found. Open a mail first (open_mail.js <index>).");
    process.exit(2);
  }

  // Step 2: MessageItem wrappers (one per reply, newest first)
  let wrappers = [];
  try {
    const q = querySelector(tabId, "[class*='MessageItem-module__wrapper']");
    wrappers = (q.elements || []).map((el) => ({
      selector: el.selector,
      preview: normalize(el.text || ""),
    }));
  } catch (e) {
    // ignore - will fall back
  }

  // Step 3: full tab text
  let fullText;
  try {
    fullText = readTab(tabId, max);
  } catch (e) {
    console.error("ERROR reading tab:", e.message);
    process.exit(3);
  }

  // Step 4: slice per wrapper anchor
  if (wrappers.length > 0) {
    // Build anchor regexes from each wrapper preview (first ~50 chars is
    // enough: sender + date is distinctive within the page).
    const anchors = wrappers.map((w) => {
      const head = w.preview.slice(0, 50);
      return { re: buildFuzzyRegex(head), preview: w.preview };
    });

    // Find positions in fullText
    const positions = [];
    for (let i = 0; i < anchors.length; i++) {
      const from = i === 0 ? 0 : positions[i - 1].end;
      const start = findFirstMatch(anchors[i].re, fullText, from);
      if (start < 0) {
        // try global search instead of forward-only
        const re = new RegExp(anchors[i].re.source, "g");
        let lastIdx = -1;
        let m;
        while ((m = re.exec(fullText)) !== null) {
          lastIdx = m.index;
          if (m.index === re.lastIndex) re.lastIndex++;
        }
        positions.push({ start: lastIdx, end: lastIdx, found: lastIdx >= 0 });
      } else {
        positions.push({ start, end: start, found: true });
      }
    }

    // Compute end of each slice = start of next wrapper, or end of detail panel.
    // We need to find where the detail panel ends. Strategy: after the LAST
    // wrapper anchor, the rest of the detail panel text continues until the
    // feed-list folder toolbar. Use trimTrailingFeedNoise.
    const slices = [];
    let anyFound = false;
    for (let i = 0; i < positions.length; i++) {
      if (!positions[i].found) {
        slices.push(null);
        continue;
      }
      anyFound = true;
      const start = positions[i].start;
      let end;
      if (i < positions.length - 1 && positions[i + 1].found) {
        end = positions[i + 1].start;
      } else {
        // last found wrapper -> slice to end then trim feed noise
        end = fullText.length;
      }
      slices.push(fullText.slice(start, end));
    }

    if (anyFound) {
      // Assemble output
      const lines = [];
      lines.push(subject);
      lines.push("");
      lines.push(`${wrappers.length} message(s) in this thread (newest first):`);
      lines.push("");
      for (let i = 0; i < slices.length; i++) {
        if (slices[i] === null) {
          lines.push(`--- message ${i + 1}: (could not locate in page text) ---`);
          lines.push("");
          continue;
        }
        let body = slices[i];
        if (i === slices.length - 1 || slices.slice(i + 1).every((s) => s === null)) {
          // last found slice - trim feed noise
          body = trimTrailingFeedNoise(body);
        }
        lines.push(`--- message ${i + 1} ---`);
        lines.push(cleanText(body));
        lines.push("");
      }
      console.log(lines.join("\n").trim());
      return;
    }
    // else fall through to subject-anchored fallback
  }

  // Fallback: subject-anchored slice (last occurrence), then trim feed noise.
  const re = buildFuzzyRegex(subject);
  if (!re) {
    console.error("ERROR: Could not build subject regex.");
    process.exit(4);
  }
  // find LAST occurrence
  const flags = new RegExp(re.source, "g");
  let lastIdx = -1;
  let m;
  while ((m = flags.exec(fullText)) !== null) {
    lastIdx = m.index;
    if (m.index === flags.lastIndex) flags.lastIndex++;
  }
  if (lastIdx < 0) {
    console.error(`ERROR: Subject not found in page text.`);
    console.error(`  Subject (first 80 chars): ${subject.slice(0, 80)}`);
    process.exit(5);
  }
  const detail = trimTrailingFeedNoise(fullText.slice(lastIdx));
  console.log(cleanText(detail));
}

main();