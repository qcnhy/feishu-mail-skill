// config.template.js - Template for scripts/config.local.js
//
// Copy this file to scripts/config.local.js and fill in your own values.
// config.local.js is git-ignored and never committed.
//
//   cp scripts/config.template.js scripts/config.local.js

module.exports = {
  // Absolute path to your local codex-edge-access-bridge checkout.
  // Get it from: https://github.com/CoderYTY/codex-edge-access-bridge
  BRIDGE_DIR: String.raw`C:\path\to\codex-edge-access-bridge`,

  // Your Feishu Mail tenant host. The skill uses this to find your mail tab.
  // It's the "<tenant>" in https://<tenant>.feishu.cn/mail
  MAIL_HOST: "your-tenant.feishu.cn",
};