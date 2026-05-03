import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { Timestamp, getFirestore } from "firebase-admin/firestore";

const email = process.argv[2];
const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "../../..");

if (!email) {
  console.error("Usage: node scripts/bootstrap-admin.mjs admin@example.com");
  process.exit(1);
}

async function resolveProjectId() {
  if (process.env.GOOGLE_CLOUD_PROJECT) {
    return process.env.GOOGLE_CLOUD_PROJECT;
  }

  const firebaseRcPath = resolve(rootDir, ".firebaserc");
  const firebaseRc = JSON.parse(await readFile(firebaseRcPath, "utf8"));
  const projects = firebaseRc.projects ?? {};
  const firstProjectId = Object.values(projects)[0];

  if (typeof firstProjectId !== "string" || !firstProjectId) {
    throw new Error("Unable to resolve Firebase project id. Set GOOGLE_CLOUD_PROJECT first.");
  }

  return firstProjectId;
}

const projectId = await resolveProjectId();

initializeApp({
  credential: applicationDefault(),
  projectId,
});

const auth = getAuth();
const firestore = getFirestore();

const userRecord = await auth.getUserByEmail(email);
const profileRef = firestore.collection("users").doc(userRecord.uid);
const profileSnapshot = await profileRef.get();
const now = Timestamp.now();

await profileRef.set(
  profileSnapshot.exists
    ? {
        role: "admin",
        active: true,
        updated_at: now,
      }
    : {
        uid: userRecord.uid,
        email: userRecord.email ?? email,
        username: userRecord.displayName?.trim() || email.split("@")[0] || "admin",
        active: true,
        device_id: null,
        role: "admin",
        subscription_expiry: Timestamp.fromMillis(Date.now() + 365 * 24 * 60 * 60 * 1000),
        created_at: now,
        updated_at: now,
      },
  { merge: true },
);

console.log(`Admin role granted to ${email} (${userRecord.uid}) in Firestore for project ${projectId}.`);
