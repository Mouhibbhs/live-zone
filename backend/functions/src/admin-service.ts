import { getAuth } from "firebase-admin/auth";
import { Timestamp, getFirestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";

import { USERS_COLLECTION } from "./config.js";
import type { AdminUserDto, DashboardSummaryDto, UserProfileRecord } from "./types.js";
import { adminUserToDto, timestampFromMillis } from "./utils.js";

function auth() {
  return getAuth();
}

function firestore() {
  return getFirestore();
}

function userRef(uid: string) {
  return firestore().collection(USERS_COLLECTION).doc(uid);
}

export async function listManagedUsers(): Promise<AdminUserDto[]> {
  const snapshot = await firestore().collection(USERS_COLLECTION).orderBy("created_at", "desc").limit(500).get();
  return snapshot.docs.map((document) => adminUserToDto(document.data() as UserProfileRecord));
}

export async function getDashboardSummary(): Promise<DashboardSummaryDto> {
  const users = await listManagedUsers();
  const now = Date.now();

  return {
    totalUsers: users.length,
    activeUsers: users.filter((user) => user.active).length,
    inactiveUsers: users.filter((user) => !user.active).length,
    expiredUsers: users.filter(
      (user) => user.subscriptionExpiryMs !== null && user.subscriptionExpiryMs <= now,
    ).length,
    boundDevices: users.filter((user) => Boolean(user.deviceId)).length,
  };
}

export async function createManagedUser(input: {
  email: string;
  password: string;
  username: string;
  active: boolean;
  subscriptionExpiryMs: unknown;
}) {
  const email = input.email.trim().toLowerCase();
  const username = input.username.trim();
  const password = input.password;

  if (!email || !password || password.length < 6 || username.length < 3) {
    throw new HttpsError("invalid-argument", "Email, password, and username are required.");
  }

  const userRecord = await auth().createUser({
    email,
    password,
    displayName: username,
  });

  const now = Timestamp.now();

  await userRef(userRecord.uid).set({
    uid: userRecord.uid,
    email,
    username,
    active: Boolean(input.active),
    device_id: null,
    role: "viewer",
    subscription_expiry: timestampFromMillis(input.subscriptionExpiryMs),
    created_at: now,
    updated_at: now,
  } satisfies UserProfileRecord);

  return {
    uid: userRecord.uid,
  };
}

export async function updateManagedUser(input: {
  uid: string;
  email?: string;
  username?: string;
  active?: boolean;
  subscriptionExpiryMs?: unknown;
}) {
  if (!input.uid) {
    throw new HttpsError("invalid-argument", "User id is required.");
  }

  const updates: Record<string, unknown> = {
    updated_at: Timestamp.now(),
  };

  const authUpdates: { email?: string; displayName?: string } = {};

  if (typeof input.email === "string" && input.email.trim()) {
    authUpdates.email = input.email.trim().toLowerCase();
    updates.email = authUpdates.email;
  }

  if (typeof input.username === "string" && input.username.trim()) {
    authUpdates.displayName = input.username.trim();
    updates.username = authUpdates.displayName;
  }

  if (typeof input.active === "boolean") {
    updates.active = input.active;
  }

  if ("subscriptionExpiryMs" in input) {
    updates.subscription_expiry = timestampFromMillis(input.subscriptionExpiryMs);
  }

  await userRef(input.uid).set(updates, { merge: true });

  if (Object.keys(authUpdates).length > 0) {
    await auth().updateUser(input.uid, authUpdates);
  }
}

export async function deleteManagedUser(uid: string) {
  if (!uid) {
    throw new HttpsError("invalid-argument", "User id is required.");
  }

  await auth().deleteUser(uid);
  await firestore().recursiveDelete(userRef(uid));
}

export async function resetManagedDevice(uid: string) {
  if (!uid) {
    throw new HttpsError("invalid-argument", "User id is required.");
  }

  await userRef(uid).set(
    {
      device_id: null,
      updated_at: Timestamp.now(),
    },
    { merge: true },
  );
}
