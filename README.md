# LiveZone

LiveZone is a live-TV-only IPTV platform with:

- Firebase Authentication
- Firestore for user profiles, subscriptions, favorites, admin edits, and live catalog storage
- A static Next.js website that can deploy on Firebase Hosting Spark
- A Flutter Android app that talks directly to Firebase Auth + Firestore

Movies and series are not fetched or displayed anywhere in this project.

## Spark Plan Notes

This project is now structured to work on Firebase Spark without deploying Cloud Functions.

- `firebase deploy --only "firestore,hosting"` is the supported Firebase deploy path.
- The old `backend/functions` folder is now used for local maintenance scripts only.
- Admin account bootstrap and IPTV catalog sync run locally with a service account.

One important limitation remains:

- Because Spark cannot host a secure IPTV proxy backend, live stream URLs are stored in Firestore for active users to read. That keeps the app working on Spark, but it is less secure than a server-side proxy.

## Project Structure

```text
backend/functions   Local admin + IPTV sync scripts
web                 Static Next.js website for viewers and admins
mobile              Flutter Android app
firebase.json       Firebase Hosting + Firestore deploy config
firestore.rules     Firestore security rules
```

## Firebase Setup

1. Create a Firebase project and enable:
   - Authentication with Email/Password
   - Firestore Database
   - Hosting
2. Install Firebase CLI and log in.
3. Select the project:

```bash
firebase use --add
```

4. Deploy Firestore rules and the static website:

```bash
firebase deploy --only "firestore,hosting"
```

## Website Setup

1. Copy the template env file:

```bash
cd web
copy .env.local.example .env.local
```

2. Fill in your Firebase web app values in `.env.local`.
3. Install and run locally:

```bash
npm install
npm run dev
```

4. Production export:

```bash
npm run build
```

The static export is written to `web/out` and Firebase Hosting deploys that folder.

## Netlify Deployment

This project can also deploy to Netlify as:

- a static Next.js export from `web/out`
- a Netlify serverless IPTV proxy from `netlify/functions/proxy.mjs`

Files added for Netlify:

- `netlify.toml`
- `netlify/functions/proxy.mjs`

### Netlify project settings

If you connect the repo through the Netlify dashboard, the included `netlify.toml` already sets:

- build command: `npm --prefix web ci && npm --prefix web run build`
- publish directory: `web/out`
- functions directory: `netlify/functions`

### Required environment variables

Add these in Netlify Site configuration -> Environment variables:

```text
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=...
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
NEXT_PUBLIC_FIREBASE_APP_ID=...
```

Optional override:

```text
NEXT_PUBLIC_IPTV_PROXY_URL=https://your-site.netlify.app/.netlify/functions/proxy
```

If you do not set `NEXT_PUBLIC_IPTV_PROXY_URL`, the app will automatically use:

- `http://localhost:8787/proxy` on local development
- `/.netlify/functions/proxy` on non-local hosts

### Important limitation

The Netlify deployment can proxy IPTV playback requests, but it does not replace the local maintenance workflow that writes `backend/functions/.env` and regenerates `web/public/channels.json`.

Keep using this locally when IPTV credentials change:

```bash
cd backend/functions
npm run sync:catalog
```

## Mobile Setup

Flutter was not available in this workspace, so the mobile source was updated but not compiled locally here.

1. Install Flutter and Android Studio.
2. In `mobile/`, run:

```bash
flutter pub get
flutterfire configure
flutter run
```

3. Replace the placeholder values in `mobile/lib/src/core/services/firebase_options.dart` if you are not using `flutterfire configure`.

## Local Admin Scripts

Install backend script dependencies once:

```bash
cd backend/functions
npm install
```

Set Application Default Credentials in PowerShell before running the scripts:

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS="C:\path\to\service-account.json"
$env:GOOGLE_CLOUD_PROJECT="livezone-cf654"
```

### Grant Admin Access

Create the auth user first, then mark the Firestore profile as admin:

```bash
cd backend/functions
npm run bootstrap:admin -- admin@example.com
```

This script updates the user's Firestore profile with:

- `role: "admin"`
- `active: true`

### Sync IPTV Catalog Into Firestore

Create `backend/functions/.env` from the example:

```bash
cd backend/functions
copy .env.example .env
```

Expected values:

```text
XTREAM_BASE_URL=http://iptv.com:80
XTREAM_USERNAME=admin
XTREAM_PASSWORD=admin123
```

Then sync the live categories and live channels into Firestore:

```bash
cd backend/functions
npm run sync:catalog
```

This writes:

- `live_categories/{categoryId}`
- `live_channels/{channelId}`
- `system/live_catalog`

The admin dashboard now also includes an IPTV settings section. It stores:

- `system/iptv_config.baseUrl`
- `system/iptv_config.username`
- `system/iptv_config.password`

The sync script reads `system/iptv_config` first and falls back to `backend/functions/.env` if that document does not exist yet.

## Live Access Rules

- Users sign in with Firebase Auth email/password.
- A Firestore user profile is created on first sign-in.
- Viewer access is allowed only when:
  - `active` is `true`
  - `subscription_expiry` is in the future
  - the stored device id matches, if one is already locked
- Favorites are stored in `users/{uid}/favorites`.
- Admin access is based on `users/{uid}.role == "admin"`.

## Current Admin Capabilities On Spark

- Create users from the web admin panel
- Activate/deactivate users
- Set subscription expiry
- Reset device lock
- View user list and summary

Auth-account deletion is not handled from the web admin panel because that needs a server-side admin backend.

## Important Files

- [Web shell](./web/src/components/dashboard/livezone-shell.tsx)
- [Web Firebase API](./web/src/lib/api.ts)
- [Mobile Firebase service](./mobile/lib/src/core/services/livezone_api.dart)
- [Firestore rules](./firestore.rules)
- [Admin bootstrap script](./backend/functions/scripts/bootstrap-admin.mjs)
- [IPTV sync script](./backend/functions/scripts/sync-live-catalog.mjs)
