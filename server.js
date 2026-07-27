const express = require("express");

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.post("/capture", (req, res) => {
  console.log("Received Zapier capture:", JSON.stringify(req.body));
  res.status(200).json({ success: true });
});

const port = process.env.PORT || 3000;

app.listen(port, "0.0.0.0", () => {
  console.log(`zapier-webhook listening on port ${port}`);
});
