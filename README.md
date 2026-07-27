# zapier-webhook v2

Receives structured GTD data from Zapier, writes it to `00 Inbox/AI Inbox.md`,
and uses Obsidian Headless to sync the Railway volume with an existing
Obsidian Sync remote vault.

## Railway volume

Mount a persistent Railway volume at `/data`.

## Required Railway variables

- `CAPTURE_TOKEN` — long random secret shared only with Zapier
- `OBSIDIAN_EMAIL` — Obsidian account email
- `OBSIDIAN_PASSWORD` — Obsidian account password
- `OBSIDIAN_REMOTE_VAULT` — exact name or ID of the existing remote Sync vault

Optional:

- `OBSIDIAN_E2E_PASSWORD` — only if the remote vault uses a separate E2E password
- `OBSIDIAN_DEVICE_NAME` — defaults to `Railway AI Inbox`
- `VAULT_PATH` — defaults to `/data/vault`
- `INBOX_PATH` — defaults to `00 Inbox/AI Inbox.md`

## Webhook authentication

Send either:

`Authorization: Bearer YOUR_CAPTURE_TOKEN`

or:

`X-Capture-Token: YOUR_CAPTURE_TOKEN`

to `POST /capture`.

## Safety

The service initially writes only to `00 Inbox/AI Inbox.md`; it does not edit
project notes automatically.
