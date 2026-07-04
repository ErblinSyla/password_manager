# Password Manager (Zero-Knowledge)

This repo contains a Chrome Extension (MV3) + backend API + Postgres DB for a password manager prototype.

Core security model (high level):
- Master password is used **locally** to derive an encryption key (PBKDF2 + SHA-256, 200k iterations).
- Vault entries are encrypted with **AES-256-GCM**.
- Backend stores only `{ domain, ciphertext, iv }` (no plaintext passwords).
- The derived key is kept only in background **RAM** and auto-locks after inactivity.

## Repo structure
- `backend/` — Express + TypeScript + Prisma
- `extension/` — Chrome Extension (MV3): popup, background service worker, content script
- `shared/` — shared types/constants (WIP)

## Prerequisites
- Node.js (LTS recommended)
- Docker Desktop (for Postgres)
- Google Chrome (for loading the extension)

## First-time setup

### 1) Install dependencies
From repo root:

```bash
npm install
```

### 2) Start Postgres (Docker)
From repo root:

```bash
docker compose up -d
```

This starts Postgres on `localhost:5432` (see `docker-compose.yml`).

### 3) Backend environment variables
Create `backend/.env`.

Recommended values (match `docker-compose.yml`):

```env
DATABASE_URL="postgresql://<username>:<password>@localhost:5432/<db_name>"
JWT_SECRET="use-a-long-random-string-at-least-32-chars"
JWT_EXPIRES_IN="7d"
PORT=3001
HOST="0.0.0.0"
CORS_ORIGIN="*"
CORS_METHODS="GET,POST,PUT,DELETE"
CORS_ALLOWED_HEADERS="Content-Type,Authorization"
```

The backend will use these values automatically, and `backend/.env.example` contains the same defaults.

### 4) Extension environment variables
Create `extension/.env`.

```env
EXTENSION_API_BASE="http://localhost:3001/api"
```

The extension uses a small config generation step to turn this into the browser-side config that the popup and background worker read. The config is regenerated automatically when you run the extension dev script.

### 5) Apply Prisma migrations
From repo root:

```bash
npm -w backend exec prisma migrate deploy
```

If you prefer running inside `backend/`:

```bash
cd backend
npx prisma migrate deploy
```

## Running the project (dev)

### Terminal A — Backend API
From repo root:

```bash
npm run dev:backend
```

Backend runs at `http://localhost:3001`.

### Terminal B — Extension popup (optional preview)
This is only a UI preview and does **not** have full extension APIs.

```bash
npm run dev:extension
```

Vite opens the popup at something like `http://localhost:5173/popup.html`.

### Load the real Chrome extension (recommended)
1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `extension/` folder
5. After code changes: click **Reload** on the extension

## Basic usage / test flow

### Sign in + unlock
1. Open the extension popup
2. Register or log in
3. Vault should show **locked** (authentication is separate from unlock)
4. Unlock with the master password

### Auto-save (on form submit)
- When the vault is **unlocked**, submitting a login form on a website will attempt to auto-save:
  - Content script captures username/password from the submitted form
  - Background encrypts with the in-RAM key
  - Backend stores `{ domain, ciphertext, iv }`

### Autofill
1. Visit a site with a visible login form
2. Open popup (must be **unlocked**)
3. Click **Refresh tab** to detect fields
4. Click **Autofill now**

### View All Credentials
1. Open the extension popup and ensure the vault is **unlocked**.
2. In the **Vault** section, use the tab buttons to switch views:
   - **This site**: Shows credentials matching the active domain.
   - **All sites**: Shows every saved credential in your vault.
3. Use the **Search bar** to filter by username or domain in real-time.


## Troubleshooting

### Extension says “Vault is locked”
- MV3 background workers can be suspended; you may need to unlock again.

### Backend auth issues
- Ensure `JWT_SECRET` is set and not a placeholder.

### Database connection issues
- Confirm Docker is running and Postgres is up: `docker ps`
- Confirm `DATABASE_URL` matches docker-compose creds.

### Windows: npm blocked by PowerShell execution policy
- If PowerShell blocks scripts, run commands in `cmd.exe` instead.

## Scripts
From repo root:
- `npm run dev:backend` — start backend dev server
- `npm run dev:extension` — start Vite popup preview

## Notes
This project is actively evolving (MVP + security hardening). Expect breaking changes.
