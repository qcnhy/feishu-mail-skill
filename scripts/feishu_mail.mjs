/**
 * feishu_mail.mjs - Helper functions for Feishu Mail automation on macOS.
 *
 * These functions run inside the node_repl (Browser skill) context.
 * Import them after bootstrapping the browser runtime and claiming a mail tab:
 *
 *   const fm = await import("./feishu_mail.mjs");
 *   await fm.listMails(mailTab, 20);
 *   await fm.switchFolder(mailTab, "已发送");
 *   await fm.openMail(mailTab, 3);
 *   await fm.readMail(mailTab);
 *
 * All functions assume mailTab is a claimed Tab from the Browser skill.
 */

export async function listMails(mailTab, limit = 20, unreadOnly = false) {
  const items = await mailTab.playwright.evaluate((max) => {
    const lis = document.querySelectorAll("ul[class*='FeedList'] li");
    const results = [];
    lis.forEach((li, i) => {
      if (i >= max) return;
      const senderEl = li.querySelector("[class*='SenderName']");
      const isRead = senderEl ? (senderEl.className || "").includes("isRead") : true;
      const text = (li.innerText || "").replace(/\s+/g, " ").trim();
      results.push({ index: i + 1, read: isRead, text: text.slice(0, 250) });
    });
    return results;
  }, limit);

  let filtered = items;
  if (unreadOnly) filtered = filtered.filter((m) => !m.read);

  const parsed = filtered.map((m) => {
    const text = m.text;
    const dateRe = /(\d{1,2}月\d{1,2}日|\d{4}\/\d{1,2}\/\d{1,2}|\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}|昨天|前天)/;
    const dateMatch = text.match(dateRe);
    const date = dateMatch ? dateMatch[1] : "";
    const sender = dateMatch ? text.slice(0, dateMatch.index).trim() : text.split(" ")[0] || "";
    const afterDate = dateMatch ? text.slice(dateMatch.index + date.length).trim() : text;
    const subject = afterDate.length > 120 ? afterDate.slice(0, 120) + "..." : afterDate;
    return { ...m, sender, date, subject };
  });

  return parsed;
}

export async function switchFolder(mailTab, folderName) {
  const result = await mailTab.playwright.evaluate((name) => {
    const folders = document.querySelectorAll(
      "li[class*='LabelListItem-module__labelListItem']"
    );
    const list = [];
    let matched = null;

    for (const li of folders) {
      const rawText = (li.innerText || "").replace(/\s+/g, " ").trim();
      const m = rawText.match(/^(.+?)\s+(\d+)$/);
      const folderText = m ? m[1].trim() : rawText;
      const isActive = (li.className || "").includes("LabelListItem-module__active");
      list.push({ name: folderText, count: m ? parseInt(m[2]) : null, isActive });

      if (!matched) {
        const lower = folderText.toLowerCase();
        const want = name.toLowerCase();
        if (lower === want || lower.startsWith(want) || lower.includes(want)) {
          matched = { element: li, name: folderText, wasActive: isActive };
        }
      }
    }

    if (!matched) {
      return { error: "Folder not found: " + name, available: list.map((f) => f.name) };
    }
    if (matched.wasActive) {
      return { ok: true, message: "Already in folder: " + matched.name };
    }
    matched.element.click();
    return { ok: true, message: "Switched to: " + matched.name };
  }, folderName);

  if (result.ok || !result.error) {
    await mailTab.playwright.waitForTimeout(1500);
  }
  return result.message || JSON.stringify(result);
}

export async function openMail(mailTab, index) {
  const result = await mailTab.playwright.evaluate((idx) => {
    const selector = "ul[class*='FeedList'] li:nth-of-type(" + idx + ")";
    const el = document.querySelector(selector);
    if (!el) return { error: "No mail at index #" + idx };
    el.click();
    const text = (el.innerText || "").replace(/\s+/g, " ").trim();
    return { ok: true, text: text.slice(0, 200) };
  }, index);

  if (result.ok) await mailTab.playwright.waitForTimeout(2000);
  return result.error || ("Opened mail #" + index + ": " + (result.text || ""));
}

export async function readMail(mailTab, maxChars = 30000) {
  const content = await mailTab.playwright.evaluate((max) => {
    const subjectEl = document.querySelector("[class*='threadHeaderTitleText']");
    const subject = subjectEl ? subjectEl.innerText.trim() : "";

    const wrappers = document.querySelectorAll(
      "[class*='MessageItem-module__wrapper']"
    );
    const messages = [];
    wrappers.forEach((w) => {
      let text = (w.innerText || "").replace(/\brangeDom\b\s*/g, "").trim();
      text = text.replace(/(\n\s*(回复|回复全部|转发)\s*)+\s*$/m, "").trim();
      messages.push(text.slice(0, max));
    });
    return { subject, count: messages.length, messages };
  }, maxChars);

  if (content.messages.length === 0) {
    const fullText = await mailTab.playwright.evaluate((max) => {
      return document.body.innerText.slice(0, max);
    }, maxChars);
    return { subject: content.subject || "", count: 1, messages: [fullText], fallback: true };
  }
  return content;
}

export async function listFolders(mailTab) {
  return await mailTab.playwright.evaluate(() => {
    const folders = document.querySelectorAll(
      "li[class*='LabelListItem-module__labelListItem']"
    );
    const list = [];
    folders.forEach((li) => {
      const rawText = (li.innerText || "").replace(/\s+/g, " ").trim();
      const m = rawText.match(/^(.+?)\s+(\d+)$/);
      const name = m ? m[1].trim() : rawText;
      const count = m ? parseInt(m[2]) : null;
      const isActive = (li.className || "").includes("LabelListItem-module__active");
      list.push({ name, count, isActive });
    });
    return list;
  });
}

