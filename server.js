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
  process.env.PROJECTS_PATH || "01. Projects";

const PROJECT_TEMPLATE_RELATIVE_PATH =
  process.env.PROJECT_TEMPLATE_PATH ||
  path.join("90. Templates", "Project Template.md");

let syncProcess = null;
let syncReady = false;
let syncError = null;

/* -----------------------------
   Obsidian Sync
------------------------------ */

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

  runOb(["login", "--email", email, "--password", password]);

  let localVaults = "";

  try {
    localVaults = runOb(["sync-list-local"]);
  } catch (_) {}

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

  // Initial sync before accepting writes
  runOb(["sync", "--path", VAULT_PATH]);

  syncProcess = spawn(
    "ob",
    ["sync", "--path", VAULT_PATH, "--continuous"],
    {
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  syncProcess.stdout.on("data", (d) =>
    console.log(`[obsidian-sync] ${d.toString().trim()}`)
  );

  syncProcess.stderr.on("data", (d) =>
    console.error(`[obsidian-sync] ${d.toString().trim()}`)
  );

  syncProcess.on("exit", (code, signal) => {
    syncReady = false;
    syncError =
      `Obsidian sync exited (code=${code}, signal=${signal})`;

    console.error(syncError);
  });

  syncReady = true;
  syncError = null;
}

/* -----------------------------
   Authentication
------------------------------ */

function authCapture(req, res, next) {
  const expected = process.env.CAPTURE_TOKEN;

  if (!expected) {
    return res.status(503).json({
      success: false,
      error: "CAPTURE_TOKEN not configured",
    });
  }

  const auth = req.get("authorization") || "";

  const supplied = auth.startsWith("Bearer ")
    ? auth.slice(7)
    : req.get("x-capture-token");

  if (supplied !== expected) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized",
    });
  }

  next();
}

/* -----------------------------
   Utility functions
------------------------------ */

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
    String(value).toLowerCase() === "true"
  );
}

/*
Prevent project names from accidentally
creating paths outside 01. Projects.
*/
function safeProjectName(name) {
  const cleaned = clean(name);

  if (!cleaned) return null;

  return cleaned
    .replace(/[\/\\]/g, "-")
    .replace(/:/g, " -")
    .trim();
}

/* -----------------------------
   AI Inbox rendering
------------------------------ */

function renderInboxCapture(body, filedProject = null) {
  const timestamp = new Date().toISOString();

  const classification =
    clean(body.classification) || "unknown";

  const summary = clean(body.summary);

  const needsReview = isTrue(body.needs_review);

  const reviewReason = clean(body.review_reason);

  const lines = [
    "",
    "---",
    `### AI Capture — ${timestamp}`,
    `**Classification:** ${classification}`,
  ];

  if (filedProject) {
    lines.push(
      `**Filed to:** [[${filedProject}]]`
    );
  } else if (clean(body.project)) {
    lines.push(
      `**Suggested project:** [[${clean(body.project)}]]`
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

  /*
  If the item is staying in the inbox,
  include the actual task/waiting text.
  */

  if (!filedProject) {
    const nextActions =
      clean(body.next_actions_markdown);

    const waitingFor =
      clean(body.waiting_for_markdown);

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

    if (!nextActions && !waitingFor) {
      lines.push(
        "",
        "_No task or waiting-for item created._"
      );
    }
  }

  return lines.join("\n") + "\n";
}

/* -----------------------------
   Project handling
------------------------------ */

async function projectExists(projectPath) {
  try {
    await fs.access(projectPath);
    return true;
  } catch {
    return false;
  }
}

async function createProject(projectName, projectPath) {
  await fs.mkdir(path.dirname(projectPath), {
    recursive: true,
  });

  const templatePath = path.join(
    VAULT_PATH,
    PROJECT_TEMPLATE_RELATIVE_PATH
  );

  let content;

  try {
    content = await fs.readFile(
      templatePath,
      "utf8"
    );

    /*
    Support a few common template placeholders
    if they're present.
    */
    content = content
      .replace(/\{\{title\}\}/gi, projectName)
      .replace(/\{\{project\}\}/gi, projectName)
      .replace(/\{\{name\}\}/gi, projectName);

    /*
    If template doesn't appear to contain
    the project title, add it.
    */
    if (!content.includes(projectName)) {
      content =
        `# ${projectName}\n\n` + content;
    }
  } catch (_) {
    /*
    Fallback if the template isn't found.
    */
    content =
      `# ${projectName}\n\n` +
      `## Next Actions\n\n` +
      `## Waiting For\n\n` +
      `## Notes\n`;
  }

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

async function appendToProject(
  projectPath,
  body
) {
  const timestamp = new Date().toISOString();

  const nextActions =
    clean(body.next_actions_markdown);

  const waitingFor =
    clean(body.waiting_for_markdown);

  const summary = clean(body.summary);

  const lines = [
    "",
    "",
    `### AI Capture — ${timestamp}`,
  ];

  if (summary) {
    lines.push(`**Summary:** ${summary}`);
  }

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

  if (!nextActions && !waitingFor) {
    lines.push(
      "",
      "_No task or waiting-for item created._"
    );
  }

  await fs.appendFile(
    projectPath,
    lines.join("\n") + "\n",
    "utf8"
  );
}

/* -----------------------------
   Filing logic
------------------------------ */

async function fileCapture(body) {
  const projectName =
    safeProjectName(body.project);

  const needsReview =
    isTrue(body.needs_review);

  const inboxPath = path.join(
    VAULT_PATH,
    INBOX_RELATIVE_PATH
  );

  await fs.mkdir(
    path.dirname(inboxPath),
    { recursive: true }
  );

  /*
  Anything requiring human review
  stays in AI Inbox.
  */
  if (needsReview) {
    await fs.appendFile(
      inboxPath,
      renderInboxCapture(body),
      "utf8"
    );

    return {
      destination: INBOX_RELATIVE_PATH,
      project: null,
      reason: "needs_review",
    };
  }

  /*
  No project identified:
  leave in AI Inbox.
  */
  if (!projectName) {
    await fs.appendFile(
      inboxPath,
      renderInboxCapture(body),
      "utf8"
    );

    return {
      destination: INBOX_RELATIVE_PATH,
      project: null,
      reason: "no_project",
    };
  }

  /*
  Project identified.
  */
  const projectRelativePath = path.join(
    PROJECTS_RELATIVE_PATH,
    `${projectName}.md`
  );

  const projectPath = path.join(
    VAULT_PATH,
    projectRelativePath
  );

  /*
  Create project if necessary.
  */
  if (!(await projectExists(projectPath))) {
    await createProject(
      projectName,
      projectPath
    );
  }

  /*
  Add the actionable content
  to the project.
  */
  await appendToProject(
    projectPath,
    body
  );

  /*
  Leave a lightweight audit record
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
    destination: projectRelativePath,
    project: projectName,
    reason: "project",
  };
}

/* -----------------------------
   Routes
------------------------------ */

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
          error:
            "Obsidian Sync is not ready",
          detail: syncError,
        });
      }

      console.log(
        "Capture received:",
        JSON.stringify(req.body)
      );

      const result =
        await fileCapture(req.body);

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
        error: error.message,
      });
    }
  }
);

/* -----------------------------
   Start server
------------------------------ */

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `zapier-webhook listening on port ${PORT}`
    );

    setupObsidianSync().catch(
      (error) => {
        syncReady = false;
        syncError = error.message;

        console.error(
          "Obsidian Sync setup failed:",
          error
        );
      }
    );
  }
);
