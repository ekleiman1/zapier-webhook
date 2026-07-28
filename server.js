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

const PROJECTS_RELATIVE_PATH =
  process.env.PROJECTS_PATH || "01 Projects";

const TIME_ZONE =
  process.env.TIME_ZONE || "America/New_York";

let syncProcess = null;
let syncReady = false;
let syncError = null;
let syncSupervisorRunning = false;
let shuttingDown = false;
let httpServer = null;

/*
 The Obsidian Sync lock is a directory at
 <vault>/.obsidian/.sync.lock. The holder refreshes its
 mtime every second; any lock older than 5s is considered
 stale and is taken over automatically.

 So "Another sync instance is already running" always means
 a genuinely live process — in practice the previous Railway
 container during a deploy overlap — not a stale lock file.
 Retrying until that container exits is the correct response.
*/
const SYNC_RETRY_DELAY_MS = 8000;
const SYNC_MAX_ATTEMPTS = 30;

/*
 If sync starts but prints nothing we recognise, treat a
 process that stays alive this long as healthy rather than
 failing closed on a wording change.
*/
const SYNC_ASSUME_READY_MS = 20000;

/*
 How long POST /capture will wait for sync to come up
 before giving Zapier a 503 to retry against.
*/
const CAPTURE_SYNC_WAIT_MS = 60000;

/* =========================================================
   Obsidian Sync
   ========================================================= */

function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

function requireEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}`
    );
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

  const e2ePassword =
    process.env.OBSIDIAN_E2E_PASSWORD;

  const deviceName =
    process.env.OBSIDIAN_DEVICE_NAME ||
    "Railway AI Inbox";

  await fs.mkdir(VAULT_PATH, {
    recursive: true,
  });

  runOb([
    "login",
    "--email",
    email,
    "--password",
    password,
  ]);

  let localVaults = "";

  try {
    localVaults = runOb([
      "sync-list-local",
    ]);
  } catch (_) {
    // Fine on first setup.
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
      args.push(
        "--password",
        e2ePassword
      );
    }

    runOb(args);
  }

  await superviseSync();
}

/*
 Spawn continuous sync and resolve only once it has
 actually started. Rejects if the process dies first,
 flagging lock conflicts so the caller can retry.
*/
function startSyncProcess() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ob",
      [
        "sync",
        "--path",
        VAULT_PATH,
        "--continuous",
      ],
      {
        stdio: [
          "ignore",
          "pipe",
          "pipe",
        ],
      }
    );

    let settled = false;
    let lockConflict = false;
    let assumeReadyTimer = null;

    const markReady = () => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(assumeReadyTimer);
      resolve(child);
    };

    assumeReadyTimer = setTimeout(
      markReady,
      SYNC_ASSUME_READY_MS
    );

    const handleOutput = (data) => {
      const text = data.toString();

      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .forEach((line) =>
          console.log(
            `[obsidian-sync] ${line}`
          )
        );

      if (
        /another sync instance is already running/i.test(
          text
        )
      ) {
        lockConflict = true;
      }

      if (
        /starting sync|fully synced/i.test(
          text
        )
      ) {
        markReady();
      }
    };

    child.stdout.on(
      "data",
      handleOutput
    );

    child.stderr.on(
      "data",
      handleOutput
    );

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(assumeReadyTimer);
      reject(error);
    });

    child.on(
      "exit",
      (code, signal) => {
        const message =
          `Obsidian sync exited ` +
          `(code=${code}, signal=${signal})`;

        if (!settled) {
          settled = true;
          clearTimeout(assumeReadyTimer);

          const error = new Error(
            message
          );

          error.lockConflict =
            lockConflict;

          return reject(error);
        }

        /*
         Died after a healthy start: drop
         readiness and try to come back.
        */
        syncProcess = null;
        syncReady = false;
        syncError = message;

        console.error(message);

        if (!shuttingDown) {
          superviseSync().catch(
            (error) =>
              console.error(
                "Sync restart failed:",
                error
              )
          );
        }
      }
    );
  });
}

/*
 Keep retrying until sync owns the vault lock. The previous
 container releases it on shutdown, so this converges as
 soon as the old deploy is gone.
*/
async function superviseSync() {
  if (syncSupervisorRunning) {
    return;
  }

  syncSupervisorRunning = true;

  try {
    for (
      let attempt = 1;
      attempt <= SYNC_MAX_ATTEMPTS &&
      !shuttingDown;
      attempt++
    ) {
      try {
        syncProcess =
          await startSyncProcess();

        syncReady = true;
        syncError = null;

        console.log(
          "[obsidian-sync] Continuous sync is running."
        );

        return;
      } catch (error) {
        syncProcess = null;
        syncReady = false;
        syncError = error.message;

        if (shuttingDown) {
          return;
        }

        const reason = error.lockConflict
          ? "another live sync instance holds the vault lock"
          : error.message;

        console.error(
          `[obsidian-sync] Start attempt ` +
            `${attempt}/${SYNC_MAX_ATTEMPTS} ` +
            `failed: ${reason}`
        );

        if (
          attempt < SYNC_MAX_ATTEMPTS
        ) {
          await sleep(
            SYNC_RETRY_DELAY_MS
          );
        }
      }
    }

    if (!syncReady && !shuttingDown) {
      syncError =
        `Obsidian sync did not start after ` +
        `${SYNC_MAX_ATTEMPTS} attempts. ` +
        `Last error: ${syncError}`;

      console.error(syncError);
    }
  } finally {
    syncSupervisorRunning = false;
  }
}

async function waitForSync(timeoutMs) {
  const deadline =
    Date.now() + timeoutMs;

  while (
    !syncReady &&
    !shuttingDown &&
    Date.now() < deadline
  ) {
    await sleep(500);
  }

  return syncReady;
}

/*
 Release the vault lock promptly on redeploy so the
 replacement container can acquire it immediately.
*/
function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  syncReady = false;

  console.log(
    `[shutdown] ${signal} received; ` +
      `releasing Obsidian Sync lock...`
  );

  const finish = () => {
    console.log(
      "[shutdown] Complete."
    );

    process.exit(0);
  };

  if (httpServer) {
    httpServer.close();
  }

  if (
    syncProcess &&
    syncProcess.exitCode === null
  ) {
    const force = setTimeout(() => {
      try {
        syncProcess.kill("SIGKILL");
      } catch (_) {
        // Already gone.
      }

      finish();
    }, 8000);

    syncProcess.on("exit", () => {
      clearTimeout(force);
      finish();
    });

    syncProcess.kill("SIGTERM");

    return;
  }

  finish();
}

/* =========================================================
   Authentication
   ========================================================= */

function authCapture(req, res, next) {
  const expected =
    process.env.CAPTURE_TOKEN;

  if (!expected) {
    return res.status(503).json({
      success: false,
      error:
        "CAPTURE_TOKEN not configured",
    });
  }

  const authorization =
    req.get("authorization") || "";

  const supplied =
    authorization.startsWith("Bearer ")
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

/* =========================================================
   General helpers
   ========================================================= */

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

function isTrue(value) {
  return (
    value === true ||
    String(value).toLowerCase() ===
      "true"
  );
}

function safeProjectName(name) {
  const cleaned = clean(name);

  if (!cleaned) {
    return null;
  }

  return cleaned
    .replace(/[\/\\]/g, "-")
    .replace(/:/g, " -")
    .trim();
}

function today() {
  return new Intl.DateTimeFormat(
    "en-CA",
    {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }
  ).format(new Date());
}

function timestamp() {
  return new Intl.DateTimeFormat(
    "en-US",
    {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "numeric",
      minute: "2-digit",
    }
  ).format(new Date());
}

/* =========================================================
   Markdown helpers
   ========================================================= */

function normalizeTaskLines(markdown) {
  const value = clean(markdown);

  if (!value) {
    return [];
  }

  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      line.startsWith("- [ ]")
    );
}

/*
 Insert text immediately underneath a Markdown heading.

 If the heading doesn't exist, it is created at
 the bottom of the note.
*/
function insertUnderHeading(
  content,
  heading,
  newLines
) {
  if (!newLines.length) {
    return content;
  }

  const lines =
    content.split(/\r?\n/);

  const headingIndex =
    lines.findIndex(
      (line) =>
        line.trim() === heading
    );

  /*
   Avoid inserting duplicate task lines.
  */
  const uniqueLines =
    newLines.filter(
      (newLine) =>
        !lines.some(
          (existingLine) =>
            existingLine.trim() ===
            newLine.trim()
        )
    );

  if (!uniqueLines.length) {
    return content;
  }

  if (headingIndex === -1) {
    const suffix = [
      "",
      heading,
      "",
      ...uniqueLines,
      "",
    ];

    return (
      content.trimEnd() +
      "\n" +
      suffix.join("\n")
    );
  }

  /*
   Find the first non-empty content line
   after the heading and insert before it.
   This keeps new tasks at the top.
  */
  let insertAt =
    headingIndex + 1;

  while (
    insertAt < lines.length &&
    lines[insertAt].trim() === ""
  ) {
    insertAt++;
  }

  lines.splice(
    insertAt,
    0,
    ...uniqueLines,
    ""
  );

  return lines.join("\n");
}

/*
 Add an informational note beneath Notes.

 Unlike tasks, these are intentionally
 timestamped so the project retains useful
 context from incoming email.
*/
function insertSummaryIntoNotes(
  content,
  summary
) {
  const value = clean(summary);

  if (!value) {
    return content;
  }

  const noteLine =
    `- ${timestamp()} — ${value}`;

  /*
   Avoid exact duplicate summaries.
  */
  if (content.includes(value)) {
    return content;
  }

  return insertUnderHeading(
    content,
    "## 📝 Notes",
    [noteLine]
  );
}

/* =========================================================
   Project creation
   ========================================================= */

async function projectExists(
  projectPath
) {
  try {
    await fs.access(projectPath);
    return true;
  } catch {
    return false;
  }
}

function createCleanProjectContent(
  projectName
) {
  return `---
type: project
status: active
area:
created: ${today()}
---

# ${projectName}

## 🎯 Outcome

What does "done" look like?

## ▶️ Next Actions


## ⏳ Waiting For


## 📝 Notes


## 📎 Resources

`;
}

async function createProject(
  projectName,
  projectPath
) {
  await fs.mkdir(
    path.dirname(projectPath),
    {
      recursive: true,
    }
  );

  const content =
    createCleanProjectContent(
      projectName
    );

  await fs.writeFile(
    projectPath,
    content,
    "utf8"
  );

  console.log(
    "Created project:",
    projectPath
  );
}

/* =========================================================
   Update project
   ========================================================= */

async function updateProject(
  projectPath,
  body
) {
  let content =
    await fs.readFile(
      projectPath,
      "utf8"
    );

  const nextActions =
    normalizeTaskLines(
      body.next_actions_markdown
    );

  const waitingFor =
    normalizeTaskLines(
      body.waiting_for_markdown
    );

  /*
   Remove the empty placeholder Next Action
   from older project templates, if present.
  */
  content = content.replace(
    /^- \[[ xX]\]\s+#next(?:\s+✅\s+\d{4}-\d{2}-\d{2})?\s*$/gm,
    ""
  );

  content = insertUnderHeading(
    content,
    "## ▶️ Next Actions",
    nextActions
  );

  content = insertUnderHeading(
    content,
    "## ⏳ Waiting For",
    waitingFor
  );

  content = insertSummaryIntoNotes(
    content,
    body.summary
  );

  /*
   Clean up excessive blank lines,
   but preserve readable section spacing.
  */
  content = content.replace(
    /\n{4,}/g,
    "\n\n\n"
  );

  await fs.writeFile(
    projectPath,
    content.trimEnd() + "\n",
    "utf8"
  );

  console.log(
    "Updated project:",
    projectPath
  );
}

/* =========================================================
   AI Inbox
   ========================================================= */

function renderInboxCapture(
  body,
  filedProject = null
) {
  const classification =
    clean(body.classification) ||
    "unknown";

  const summary =
    clean(body.summary);

  const needsReview =
    isTrue(body.needs_review);

  const reviewReason =
    clean(body.review_reason);

  const nextActions =
    clean(
      body.next_actions_markdown
    );

  const waitingFor =
    clean(
      body.waiting_for_markdown
    );

  const lines = [
    "",
    "---",
    `### AI Capture — ${timestamp()}`,
    `**Classification:** ${classification}`,
  ];

  if (filedProject) {
    lines.push(
      `**Filed to:** [[${filedProject}]]`
    );
  } else if (
    clean(body.project)
  ) {
    lines.push(
      `**Suggested project:** [[${clean(
        body.project
      )}]]`
    );
  }

  if (summary) {
    lines.push(
      `**Summary:** ${summary}`
    );
  }

  if (needsReview) {
    lines.push(
      `**⚠ Needs review:** ${
        reviewReason ||
        "AI marked this item for review."
      }`
    );
  }

  /*
   Only include actionable content in
   Inbox when it wasn't successfully filed.
  */
  if (!filedProject) {
    if (nextActions) {
      lines.push(
        "",
        "**Next Actions**",
        nextActions
      );
    }

    if (waitingFor) {
      lines.push(
        "",
        "**Waiting For**",
        waitingFor
      );
    }

    if (
      !nextActions &&
      !waitingFor
    ) {
      lines.push(
        "",
        "_No task or waiting-for item created._"
      );
    }
  }

  return (
    lines.join("\n") + "\n"
  );
}

/* =========================================================
   Filing logic
   ========================================================= */

async function fileCapture(body) {
  const projectName =
    safeProjectName(
      body.project
    );

  const needsReview =
    isTrue(
      body.needs_review
    );

  const inboxPath =
    path.join(
      VAULT_PATH,
      INBOX_RELATIVE_PATH
    );

  await fs.mkdir(
    path.dirname(inboxPath),
    {
      recursive: true,
    }
  );

  /*
   Anything uncertain remains in Inbox.
  */
  if (needsReview) {
    await fs.appendFile(
      inboxPath,
      renderInboxCapture(body),
      "utf8"
    );

    return {
      destination:
        INBOX_RELATIVE_PATH,
      project: null,
      reason: "needs_review",
    };
  }

  /*
   No project identified:
   keep it in Inbox.
  */
  if (!projectName) {
    await fs.appendFile(
      inboxPath,
      renderInboxCapture(body),
      "utf8"
    );

    return {
      destination:
        INBOX_RELATIVE_PATH,
      project: null,
      reason: "no_project",
    };
  }

  const projectRelativePath =
    path.join(
      PROJECTS_RELATIVE_PATH,
      `${projectName}.md`
    );

  const projectPath =
    path.join(
      VAULT_PATH,
      projectRelativePath
    );

  if (
    !(await projectExists(
      projectPath
    ))
  ) {
    await createProject(
      projectName,
      projectPath
    );
  }

  await updateProject(
    projectPath,
    body
  );

  /*
   Leave only a lightweight audit trail
   in AI Inbox.
  */
  await fs.appendFile(
    inboxPath,
    renderInboxCapture(
      body,
      projectName
    ),
    "utf8"
  );

  return {
    destination:
      projectRelativePath,
    project:
      projectName,
    reason: "project",
  };
}

/* =========================================================
   Routes
   ========================================================= */

app.get(
  "/health",
  (_req, res) => {
    res.status(200).json({
      status: "ok",
      version:
        "project-routing-v3",
      sync_ready:
        syncReady,
      sync_error:
        syncError,
    });
  }
);

app.post(
  "/capture",
  authCapture,
  async (req, res) => {
    try {
      /*
       During a redeploy the lock may briefly belong to
       the outgoing container. Wait it out rather than
       dropping the capture.
      */
      if (!syncReady) {
        console.log(
          "Capture waiting for Obsidian Sync..."
        );

        const ready =
          await waitForSync(
            CAPTURE_SYNC_WAIT_MS
          );

        if (!ready) {
          return res
            .status(503)
            .json({
              success: false,
              error:
                "Obsidian Sync is not ready",
              detail: syncError,
            });
        }
      }

      console.log(
        "Capture received:",
        JSON.stringify(
          req.body
        )
      );

      const result =
        await fileCapture(
          req.body
        );

      console.log(
        "Capture filed:",
        result
      );

      res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error) {
      console.error(
        "Capture failed:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          error.message,
      });
    }
  }
);

/* =========================================================
   Start server
   ========================================================= */

process.on("SIGTERM", () =>
  shutdown("SIGTERM")
);

process.on("SIGINT", () =>
  shutdown("SIGINT")
);

httpServer = app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `zapier-webhook listening on port ${PORT}`
    );

    setupObsidianSync().catch(
      (error) => {
        syncReady = false;
        syncError =
          error.message;

        console.error(
          "Obsidian Sync setup failed:",
          error
        );
      }
    );
  }
);