import { getAuth } from "firebase-admin/auth";
import { Timestamp, getFirestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";

import { USERS_COLLECTION } from "./config.js";
import type { FavoriteChannelRecord, LiveChannelDto, UserProfileRecord, ViewerSessionDto } from "./types.js";
import { buildViewerReason, profileToDto, sanitizeUsername } from "./utils.js";

function firestore() {
  return getFirestore();
}

function userRef(uid: string) {
  return firestore().collection(USERS_COLLECTION).doc(uid);
}

function favoritesRef(uid: string) {
  return userRef(uid).collection("favorites");
}

function authErrorCode(error: unknown) {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }

  return "";
}

function registrationErrorMessage(error: unknown) {
  switch (authErrorCode(error)) {
    case "auth/email-already-exists":
      return "A user with this email already exists.";
    case "auth/invalid-email":
      return "Enter a valid email address.";
    case "auth/invalid-password":
    case "auth/weak-password":
      return "Password must contain at least 6 characters.";
    default:
      return error instanceof Error ? error.message : "Unable to create the account.";
  }
}

function registrationErrorStatus(error: unknown): "already-exists" | "invalid-argument" | "internal" {
  switch (authErrorCode(error)) {
    case "auth/email-already-exists":
      return "already-exists";
    case "auth/invalid-email":
    case "auth/invalid-password":
    case "auth/weak-password":
      return "invalid-argument";
    default:
      return "internal";
  }
}

export async function ensureInitialUserProfile(user: {
  uid: string;
  email?: string | null;
  displayName?: string | null;
}): Promise<void> {
  const ref = userRef(user.uid);
  const snapshot = await ref.get();

  if (snapshot.exists) {
    return;
  }

  const now = Timestamp.now();
  const email = user.email ?? "";

  await ref.set({
    uid: user.uid,
    email,
    username: user.displayName?.trim() || email.split("@")[0] || "livezone-user",
    active: false,
    device_id: null,
    role: "viewer",
    subscription_expiry: null,
    created_at: now,
    updated_at: now,
  } satisfies UserProfileRecord);
}

export async function registerViewerAccount(input: {
  email: unknown;
  password: unknown;
  username: unknown;
}) {
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const password = typeof input.password === "string" ? input.password : "";
  const username = sanitizeUsername(input.username);

  if (!email) {
    throw new HttpsError("invalid-argument", "Email is required.");
  }

  if (password.length < 6) {
    throw new HttpsError("invalid-argument", "Password must contain at least 6 characters.");
  }

  let uid = "";

  try {
    const userRecord = await getAuth().createUser({
      email,
      password,
      displayName: username,
    });

    uid = userRecord.uid;
    const now = Timestamp.now();

    await userRef(userRecord.uid).set({
      uid: userRecord.uid,
      email,
      username,
      active: false,
      device_id: null,
      role: "viewer",
      subscription_expiry: null,
      created_at: now,
      updated_at: now,
    } satisfies UserProfileRecord);

    return {
      uid: userRecord.uid,
      username,
    };
  } catch (error) {
    if (uid) {
      try {
        await getAuth().deleteUser(uid);
      } catch {
        throw new HttpsError(
          "internal",
          "The sign-in account was created, but the profile record could not be saved. Delete that auth user before retrying the same email.",
        );
      }
    }

    throw new HttpsError(registrationErrorStatus(error), registrationErrorMessage(error));
  }
}

export async function deleteUserData(uid: string): Promise<void> {
  await firestore().recursiveDelete(userRef(uid));
}

export async function getUserProfile(uid: string): Promise<UserProfileRecord | null> {
  const snapshot = await userRef(uid).get();
  return snapshot.exists ? (snapshot.data() as UserProfileRecord) : null;
}

async function getOrCreateUserProfile(uid: string): Promise<UserProfileRecord | null> {
  let profile = await getUserProfile(uid);

  if (profile) {
    return profile;
  }

  const auth = getAuth();
  const userRecord = await auth.getUser(uid);
  await ensureInitialUserProfile({
    uid: userRecord.uid,
    email: userRecord.email,
    displayName: userRecord.displayName,
  });

  profile = await getUserProfile(uid);
  return profile;
}

export async function buildViewerSession(uid: string, deviceId: string, isAdmin: boolean): Promise<ViewerSessionDto> {
  let profile = await getOrCreateUserProfile(uid);

  if (!profile) {
    return {
      allowed: false,
      reason: "profile_missing",
      isAdmin,
      serverTimeMs: Date.now(),
      profile: null,
    };
  }

  let reason = buildViewerReason(profile, deviceId);

  if (reason === "ok" && !profile.device_id) {
    await userRef(uid).update({
      device_id: deviceId,
      updated_at: Timestamp.now(),
    });

    profile = {
      ...profile,
      device_id: deviceId,
    };
    reason = "ok";
  }

  return {
    allowed: reason === "ok",
    reason,
    isAdmin,
    serverTimeMs: Date.now(),
    profile: profileToDto(profile),
  };
}

export async function assertViewerAllowed(uid: string, deviceId: string): Promise<UserProfileRecord> {
  const profile = await getOrCreateUserProfile(uid);
  const reason = buildViewerReason(profile, deviceId);

  if (!profile) {
    throw new HttpsError("failed-precondition", "User profile not initialized yet.");
  }

  if (reason === "inactive") {
    throw new HttpsError("permission-denied", "Subscription is inactive.");
  }

  if (reason === "expired") {
    throw new HttpsError("permission-denied", "Subscription has expired.");
  }

  if (reason === "device_mismatch") {
    throw new HttpsError("permission-denied", "This account is locked to another device.");
  }

  if (!profile.device_id) {
    await userRef(uid).update({
      device_id: deviceId,
      updated_at: Timestamp.now(),
    });

    return {
      ...profile,
      device_id: deviceId,
    };
  }

  return profile;
}

export async function updateOwnUsername(uid: string, usernameInput: unknown) {
  const username = sanitizeUsername(usernameInput);
  const auth = getAuth();

  await Promise.all([
    userRef(uid).set({
      username,
      updated_at: Timestamp.now(),
    }, { merge: true }),
    auth.updateUser(uid, { displayName: username }),
  ]);

  return username;
}

export async function listFavoriteChannels(uid: string): Promise<LiveChannelDto[]> {
  const snapshot = await favoritesRef(uid).orderBy("added_at", "desc").get();
  return snapshot.docs.map((document) => {
    const data = document.data() as FavoriteChannelRecord;
    return {
      id: document.id,
      name: data.name,
      categoryId: data.categoryId,
      logo: data.logo,
      streamUrl: data.streamUrl,
      epgChannelId: data.epgChannelId,
    };
  });
}

export async function addFavoriteChannel(uid: string, channel: LiveChannelDto): Promise<void> {
  await favoritesRef(uid).doc(channel.id).set({
    ...channel,
    added_at: Timestamp.now(),
  } satisfies FavoriteChannelRecord);
}

export async function removeFavoriteChannel(uid: string, channelId: string): Promise<void> {
  await favoritesRef(uid).doc(channelId).delete();
}
