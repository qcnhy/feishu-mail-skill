#!/usr/bin/env node
/**
 * list_mails.js - List top N Feishu inbox mails (1-based index).
 *
 * Usage:
 *   node list_mails.js [--limit 20] [--unread]
 *
 * Strategy:
 *   - Find the Feishu Mail tab.
 *   - Query `ul[class*='FeedList'] li` to get all mail list items.
 *   - For each li, also query the nested `[class*='SenderName']` element.
 *     Its className contains the substring `isRead` when the mail has been
 *     read; absence means unread (matches Feishu''s bold-not-bold visual).
 *     NOTE: Do NOT use the regex `/\bisRead\b/` — the class name is
 *     `SenderName-module__isRead--27Qt1`, where `isRead` is followed by `--`,
 *     and `-` is a non-word boundary in JS regex, so `\b` does not match.
 *     Use String.prototype.includes instead.
 *   - Parse sender + date + subject from each li''s flattened text.
 *   - With `--unread`, show only unread mails.
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

function parseMailText(raw) {
  let sender = "";
  let date = "";
  let subject = "";
  const dateRe = /(\d{1,2}月\d{1,2}日|\d{4}\/\d{1,2}\/\d{1,2}|\d{4}-\d{2}-\d{2})/;
  const dateMatch = raw.match(dateRe);
  if (dateMatch) {
    date = dateMatch[1];
    sender = raw.slice(0, dateMatch.index).trim();
  }
  if (!sender) sender = raw.split(/\s+/)[0] || "";
  let afterDate = dateMatch ? raw.slice(dateMatch.index + date.length).trim() : raw;
  const cutMatch = afterDate.match(/^(.+?)(?:[。！；]|  )/);
  if (cutMatch) subject = cutMatch[1].trim();
  else subject = afterDate.slice(0, 100).trim();
  if (subject.length > 100) subject = subject.slice(0, 100) + "...";
  return { sender, date, subject };
}

function queryJson(tabId, selector) {
  const out = execFileSync(
    "node",
    [CLIENT, "query", selector, "--tab", String(tabId), "--json"],
    { encoding: "utf8", maxBuffer: 50 * 1024 * 1024, windowsHide: true }
  );
  return JSON.parse(out);
}

function listMails(tabId, limit) {
  const liSelector = "ul[class*='FeedList'] li";
  const snSelector = "ul[class*='FeedList'] li [class*='SenderName']";
  const liData = queryJson(tabId, liSelector);
  const snData = queryJson(tabId, snSelector);
  const lis = (liData.elements || []).slice(0, limit);
  const sns = snData.elements || [];
  return lis.map((el, i) => {
    const raw = (el.text || "").replace(/\s+/g, " ").trim();
    const parsed = parseMailText(raw);
    const snEl = sns[i];
    const isRead = snEl ? (snEl.className || "").includes("isRead") : true;
    return { index: i + 1, read: isRead, ...parsed };
  });
}

function main() {
  const args = process.argv.slice(2);
  let limit = 20;
  let unreadOnly = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--unread") {
      unreadOnly = true;
    }
  }

  const tabId = findMailTabId();
  if (!tabId) {
    console.error(`ERROR: No Feishu Mail tab found. Open https://${MAIL_HOST}/mail first.`);
    process.exit(1);
  }
  console.error(`Mail tab: ${tabId}`);

  let mails;
  try {
    mails = listMails(tabId, limit);
  } catch (e) {
    console.error("ERROR querying mails:", e.message);
    process.exit(2);
  }

  if (unreadOnly) mails = mails.filter((m) => !m.read);

  if (mails.length === 0) {
    console.log(unreadOnly ? "No unread mails." : "Inbox is empty.");
    return;
  }

  for (const m of mails) {
    const tag = m.read ? " " : "*";
    console.log(`${tag}#${String(m.index).padStart(2)}  [${m.date}]  ${m.sender}`);
    console.log(`       ${m.subject}`);
    console.log("");
  }
  const unreadCount = mails.filter((m) => !m.read).length;
  console.log(`Total: ${mails.length} mail(s) shown (${unreadCount} unread). Use: open_mail.js <index>`);
  console.log(`  (* = unread)`);
}

main();