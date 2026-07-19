#!/usr/bin/env node
/**
 * download_attachment.js - Download a Feishu mail attachment to C:\Users\qcnhy\Downloads\.
 *
 * Usage:
 *   node download_attachment.js <mailIndex> <attachmentIndex>
 *   node download_attachment.js 3 1   // download attachment #1 from mail #3
 *
 * Flow (preview-based; no way around it because the in-mail download button
 * is hover-gated and the bridge has no hover command):
 *
 *   1. Open the target mail at <mailIndex>.
 *   2. Click attachment #<attachmentIndex> card -> preview overlay mounts.
 *   3. Query buttons inside [class*='Preview-module']:
 *      - Download = the rightmost icon button (max rect.x).
 *      - Exit = the unique text button (ud__button--text, says "退出").
 *      Using rect.x / className ranking is stable across DOM depth changes
 *      that occur when other modals stack on top.
 *   4. Click download. Wait for new file in Downloads.
 *   5. Click exit. Preview dismisses and the original mail is restored
 *      (no reload needed).
 *
 * Failure safety: if the exit click fails, fall back to reload.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");


// Load local config (git-ignored). Falls back to template if local copy missing.
const CONFIG_PATH = fs.existsSync(path.join(__dirname, "config.local.js"))
  ? path.join(__dirname, "config.local.js")
  : path.join(__dirname, "config.template.js");
const { BRIDGE_DIR, MAIL_HOST } = require(CONFIG_PATH);
const CLIENT = path.join(BRIDGE_DIR, "bridge", "edge-client.js");
const DOWNLOADS_DIR = "C:\\Users\\qcnhy\\Downloads";
const SKILL_DIR = "C:\\Users\\qcnhy\\.codex\\skills\\feishu-mail-assistant";

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

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

function runBridge(args) {
  return execFileSync("node", [CLIENT, ...args], {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    windowsHide: true,
  });
}

function runBridgeJson(args) {
  return JSON.parse(runBridge([...args, "--json"]));
}

function listDownloads() {
  return fs.readdirSync(DOWNLOADS_DIR)
    .filter((n) => !n.endsWith(".crdownload"))
    .map((n) => {
      const p = path.join(DOWNLOADS_DIR, n);
      const st = fs.statSync(p);
      return { name: n, path: p, size: st.size, mtime: st.mtimeMs };
    });
}

function snapshotBefore() {
  const m = new Map();
  for (const f of listDownloads()) m.set(f.name, f.mtime);
  return m;
}

function findNewFiles(before) {
  return listDownloads().filter((f) => !before.has(f.name));
}

function waitForPreviewReady(tabId, maxMs = 10000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    sleep(400);
    try {
      const r = runBridgeJson([
        "query",
        "[class*='Preview-module'] button",
        "--tab",
        String(tabId),
      ]);
      const btns = (r.elements || []).filter((b) => b.visible);
      const iconBtns = btns.filter((b) => (b.rect.x || 0) > 2700);
      const exitBtn = btns.find((b) => (b.className || "").includes("ud__button--text"));
      if (iconBtns.length >= 2 && exitBtn) {
        return { iconBtns, exitBtn };
      }
    } catch (_) {
      // not ready
    }
  }
  return null;
}

function pickDownloadButton(iconBtns) {
  const sorted = iconBtns.slice().sort((a, b) => (b.rect.x || 0) - (a.rect.x || 0));
  return sorted[0] || null;
}

function dismissPreview(tabId) {
  // Try clicking the in-preview Exit button first (preserves the underlying mail view).
  try {
    const r = runBridgeJson([
      "click",
      "[class*='Preview-module'] button.ud__button--text",
      "--tab",
      String(tabId),
    ]);
    if (r.clicked) {
      sleep(1500);
      const stillThere = runBridgeJson([
        "query",
        "[class*='Preview-module']",
        "--tab",
        String(tabId),
      ]);
      const vis = (stillThere.elements || []).filter((e) => e.visible).length;
      if (vis === 0) return true;
    }
  } catch (_) {}
  // Fallback: reload the tab.
  try {
    runBridge(["reload", "--tab", String(tabId)]);
    sleep(5000);
  } catch (_) {}
  return false;
}

function openMail(mailIdx) {
  try {
    execFileSync(
      "node",
      [path.join(SKILL_DIR, "scripts", "open_mail.js"), String(mailIdx)],
      { stdio: "ignore", encoding: "utf8", windowsHide: true }
    );
    return true;
  } catch (_) {
    return false;
  }
}

function main() {
  const mailIdx = parseInt(process.argv[2], 10);
  const attIdx = parseInt(process.argv[3], 10);
  if (!mailIdx || !attIdx) {
    console.error("Usage: node download_attachment.js <mailIndex> <attachmentIndex>");
    console.error("Example: node download_attachment.js 3 1");
    process.exit(1);
  }

  const tabId = findMailTabId();
  if (!tabId) {
    console.error("ERROR: No Feishu Mail tab found.");
    process.exit(2);
  }

  const before = snapshotBefore();

  // 1. Open the target mail
  if (!openMail(mailIdx)) {
    console.error(`ERROR: Could not open mail #${mailIdx}.`);
    process.exit(3);
  }
  sleep(2000);

  // 2. Click attachment -> preview overlay
  try {
    runBridgeJson([
      "click",
      `[class*='attachmentItem']:nth-of-type(${attIdx})`,
      "--tab",
      String(tabId),
    ]);
  } catch (e) {
    console.error("ERROR clicking attachment:", e.message);
    process.exit(4);
  }

  // 3. Wait for preview + locate download & exit buttons
  const preview = waitForPreviewReady(tabId, 10000);
  if (!preview) {
    console.error("ERROR: Preview overlay did not show toolbar buttons in time.");
    dismissPreview(tabId);
    openMail(mailIdx);
    process.exit(5);
  }
  const dlBtn = pickDownloadButton(preview.iconBtns);
  if (!dlBtn) {
    console.error("ERROR: Could not identify the download button.");
    dismissPreview(tabId);
    openMail(mailIdx);
    process.exit(6);
  }

  // 4. Click download
  let dlClicked = false;
  try {
    const r = runBridgeJson(["click", dlBtn.selector, "--tab", String(tabId)]);
    dlClicked = !!r.clicked;
  } catch (e) {
    console.error("ERROR clicking download button:", e.message);
    dismissPreview(tabId);
    openMail(mailIdx);
    process.exit(7);
  }
  if (!dlClicked) {
    console.error("ERROR: Download button did not respond.");
    dismissPreview(tabId);
    openMail(mailIdx);
    process.exit(8);
  }

  // 5. Wait for new file in Downloads (poll up to 15s)
  let newFiles = [];
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    sleep(500);
    newFiles = findNewFiles(before);
    if (newFiles.length > 0) {
      sleep(800); // let size stabilize
      break;
    }
  }

  // 6. Dismiss preview (prefers the Exit button, falls back to reload).
  //    Clicking Exit restores the original mail view automatically.
  dismissPreview(tabId);

  // 7. Report
  if (newFiles.length === 0) {
    console.error("WARNING: No new file appeared in Downloads. Download may have failed.");
    process.exit(9);
  }
  for (const f of newFiles) {
    console.log(`${f.name}\t${f.size} bytes`);
    console.log(`PATH:${f.path}`);
  }
}

main();