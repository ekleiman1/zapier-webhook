const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const VAULT_PATH = process.env.VAULT_PATH || "/data/vault";
const INBOX_RELATIVE_PATH =
  process.env.INBOX_PATH || path.join("00 Inbox", "AI Inbox.md");

let syncProcess = null;
let syncReady = false;
let syncError = null;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function runOb(args, options = {}) {
  return execFileSync("ob", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

async function setupObsidianSync() {
  const email = requireEnv("OBSIDIAN_EMAIL");
  const password = requireEnv("OBSIDIAN_PASSWORD");
  const remoteVault = requireEnv("OBSIDIAN_REMOTE_VAULT");
  const e2ePassword = process.env.OBSIDIAN_E2E_PASSWORD;
  const deviceName =
    process.env.OBSIDIAN_DEVICE_NAME || "Railway AI Inbox";

  await fs.mkdir(VAULT_PATH, { recursive: true });

  // Log in to the Obsidian account.
  runOb(["login", "--email", email, "--password", password]);

  // Determine whether this local path has already been connected.
  let localVaults = "";

  try {
    localVaults = runOb(["sync-list-local"]);
  } catch (_) {
    // If this fails on first setup, continue to sync-setup.
  }

  if (!localVaults.includes(VAULT_PATH)) {
    const args = [
      "sync-setup",
      "--vault",
      remoteVault,
      "--path",
      VAULT_PATH,
      "--device-name",
      deviceName,
    ];

    if (e2ePassword) {
      args.push("--password", e2ePassword);
    }

    runOb(args);
  }

  // Pull the latest remote vault state before accepting writes.
  runOb(["sync", "--path", VAULT_PATH]);

  // Keep syncing continuously in the background.
  syncProcess = spawn(
    "ob",
    ["sync", "--path", VAULT_PATH, "--continuous"],
    {
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  syncProcess.stdout.on("data", (data) => {
    console.log(`[obsidian-sync] ${data.toString().trim()}`);
  });

  syncProcess.stderr.on("data", (data) => {
    console.error(`[obsidian-sync] ${data.toString().trim()}`);
  });

  syncProcess.on("exit", (code, signal) => {
    syncReady = false;
    syncError = `Obsidian sync exited (code=${code}, signal=${signal})`;
    console.error(syncError);
  });

  syncReady = true;
  syncError = null;
}

function authCapture(req, res, next) {
  const expected = process.env.CAPTURE_TOKEN;

  if (!expected) {
    return res.status(503).json({
      success: false,
      error: "CAPTURE_TOKEN not configured",
    });
  }

  const authorization = req.get("authorization") || "";

  const supplied = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : req.get("x-capture-token");

  if (supplied !== expected) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized",
    });
  }

  next();
}

function clean(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  return String(value).trim();
}

function renderCapture(body) {
  const timestamp = new Date().toISOString();

  const classification =
    clean(body.classification) || "unknown";

  const project = clean(body.project);
  const summary = clean(body.summary);

  const needsReview =
    body.needs_review === true ||
    String(body.needs_review).toLowerCase() === "true";

  const reviewReason = clean(body.review_reason);

  const nextActionsMarkdown = clean(
    body.next_actions_markdown
  );

  const waitingForMarkdown = clean(
    body.waiting_for_markdown
  );

  const lines = [
    "",
    "---",
    `### AI Capture — ${timestamp}`,
    `**Classification:** ${classification}`,
  ];

  if (project) {
    lines.push(
      `**Suggested project:** [[${project}]]`
    );
  }

  if (summary) {
    lines.push(`**Summary:** ${summary}`);
  }

  if (needsReview) {
    lines.push(
      `**⚠ Needs review:** ${
        reviewReason ||
        "AI marked this item for review."
      }`
    );
  }

  if (nextActionsMarkdown) {
    lines.push("");
    lines.push("**Next Actions**");
    lines.push(nextActionsMarkdown);
  }

  if (waitingForMarkdown) {
    lines.push("");
    lines.push("**Waiting For**");
    lines.push(waitingForMarkdown);
  }

  if (
    !nextActionsMarkdown &&
    !waitingForMarkdown
  ) {
    lines.push("");
    lines.push(
      "_No task or waiting-for item created._"
    );
  }

  return lines.join("\n") + "\n";
}

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    sync_ready: syncReady,
    sync_error: syncError,
  });
});

app.post(
  "/capture",
  authCapture,
  async (req, res) => {
    try {
      if (!syncReady) {
        return res.status(503).json({
          success: false,
          error: "Obsidian Sync is not ready",
          detail: syncError,
        });
      }

      const inboxPath = path.join(
        VAULT_PATH,
        INBOX_RELATIVE_PATH
      );

      await fs.mkdir(
        path.dirname(inboxPath),
        { recursive: true }
      );

      await fs.appendFile(
        inboxPath,
        renderCapture(req.body),
        "utf8"
      );

      console.log(
        "Wrote GTD capture to:",
        inboxPath
      );

      res.status(200).json({
        success: true,
        path: INBOX_RELATIVE_PATH,
      });
    } catch (error) {
      console.error(
        "Capture failed:",
        error
      );

      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }
);

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `zapier-webhook listening on port ${PORT}`
  );

  setupObsidianSync().catch((error) => {
    syncReady = false;
    syncError = error.message;

    console.error(
      "Obsidian Sync setup failed:",
      error
    );
  });
});
