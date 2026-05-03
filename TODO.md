# IPTV .env Update Feature - TODO

## Plan
**Information Gathered:**
- Admin dashboard has IPTV settings form calling `updateAdminIptvSettings()` → saves to Firestore `system/iptv_config`
- Backend `iptv.ts` reads `.env` vars directly (XTREAM_BASE_URL, XTREAM_USERNAME, XTREAM_PASSWORD)
- `sync-live-catalog.mjs` uses same `.env` vars
- No backend endpoint exists to write `.env` file from admin panel

**Detailed Update Plan:**
```
1. backend/functions/src/index.ts → add `adminUpdateIptvEnv` onCall endpoint
   - Read Firestore iptv_config doc
   - Write/update backend/functions/.env file
   - Run sync-live-catalog.mjs via child_process.spawn
   - Return { success: true, channelsCount: N }

2. web/src/lib/api.ts → add `adminUpdateIptvEnv()` client function
   - Called from admin-dashboard.tsx after successful `updateAdminIptvSettings()`

3. admin-dashboard.tsx → update `handleSaveIptvSettings()`
   - Call `updateAdminIptvSettings()` → then `adminUpdateIptvEnv()`
   - Show "IPTV settings + catalog synced!" message
```

**Dependent Files to Edit:**
```
Required:
├── backend/functions/src/index.ts (add new onCall endpoint)
├── web/src/lib/api.ts (add client API wrapper)
├── web/src/components/dashboard/admin-dashboard.tsx (update handler)

Optional:
├── backend/functions/package.json (add child_process dependency if needed)
└── backend/functions/scripts/sync-live-catalog.mjs (make executable)
```

**Follow-up Steps:**
1. Deploy Firebase functions: `firebase deploy --only functions`
2. Test admin panel IPTV update → verify .env file + channels.json updated
3. Check browser console for any errors
4. Verify player loads new channels

**Approve this plan before I start editing files?**

