# zapier-webhook

Minimal Node.js 22 + Express webhook receiver intended for Railway.

## Endpoints

- `GET /health` → `{"status":"ok"}`
- `POST /capture` → accepts JSON, logs it, and returns `{"success":true}`

## Run locally

```bash
npm install
npm start
```

The app listens on `process.env.PORT`, falling back to port 3000 locally.

## Current scope

This initial version deliberately has:
- no database
- no authentication
- no Obsidian integration

Those can be added after the Zapier → Railway path is verified.
