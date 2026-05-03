import {
  createUserWithEmailAndPassword,
  deleteUser,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  type User,
} from "firebase/auth";
import {
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";

import { getClientAuth, getClientDb, getClientFunctions, getFirebaseWebConfig } from "./firebase";
import { normalizeLiveStreamUrl } from "./stream-url";
import type {
  AdminUser,
  DashboardSummary,
  FavoritesResponse,
  IptvSettings,
  LiveCatalog,
  LiveChannel,
  ViewerSession,
} from "./types";

type UserRole = "viewer" | "admin";

interface UserProfileRecord {
  uid: string;
  email: string;
  username: string;
  active: boolean;
  device_id: string | null;
  role: UserRole;
  subscription_expiry: Timestamp | null;
  created_at: Timestamp | null;
  updated_at: Timestamp | null;
}

interface IdentityToolkitErrorPayload {
  error?: {
    message?: string;
  };
}

interface CallableLikeError {
  code?: string;
  message?: string;
}

const USERS_COLLECTION = "users";
const FAVORITES_COLLECTION = "favorites";
const SYSTEM_COLLECTION = "system";
const LIVE_CATALOG_DOC = "live_catalog";
const IPTV_SETTINGS_DOC = "iptv_config";

// In-memory cache for the channel catalog so setFavoriteChannel can look up channels
let catalogCache: LiveCatalog | null = null;

function sanitizeUsername(input: string): string {
  const value = input.trim().replace(/\s+/g, " ");

  if (value.length < 3 || value.length > 32) {
    throw new Error("Username must be between 3 and 32 characters.");
  }

  return value;
}

function buildFallbackUsername(preferredUsername?: string | null, email?: string | null): string {
  const candidates = [preferredUsername, email?.split("@")[0], "livezone-user"];

  for (const candidate of candidates) {
    const value = (candidate ?? "").trim();

    if (value.length >= 3) {
      return sanitizeUsername(value);
    }
  }

  return "livezone-user";
}

function toMillis(value: unknown): number | null {
  if (value instanceof Timestamp) {
    return value.toMillis();
  }

  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getViewerReason(profile: UserProfileRecord | null, deviceId: string): ViewerSession["reason"] {
  if (!profile) {
    return "profile_missing";
  }

  if (!profile.active) {
    return "inactive";
  }

  const expiryMs = toMillis(profile.subscription_expiry);

  if (!expiryMs || expiryMs <= Date.now()) {
    return "expired";
  }

  if (profile.device_id && profile.device_id !== deviceId) {
    return "device_mismatch";
  }

  return "ok";
}

function mapViewerProfile(profile: UserProfileRecord) {
  return {
    uid: profile.uid,
    email: profile.email,
    username: profile.username,
    active: profile.active,
    role: profile.role,
    deviceId: profile.device_id,
    subscriptionExpiryMs: toMillis(profile.subscription_expiry),
  };
}

function mapAdminUser(profile: UserProfileRecord): AdminUser {
  return {
    uid: profile.uid,
    email: profile.email,
    username: profile.username,
    active: profile.active,
    role: profile.role,
    deviceId: profile.device_id,
    subscriptionExpiryMs: toMillis(profile.subscription_expiry),
    createdAtMs: toMillis(profile.created_at),
  };
}

function userDoc(userId: string) {
  return doc(getClientDb(), USERS_COLLECTION, userId);
}

function favoriteDoc(userId: string, channelId: string) {
  return doc(getClientDb(), USERS_COLLECTION, userId, FAVORITES_COLLECTION, channelId);
}

function mapUserProfile(
  value: Record<string, unknown>,
  fallback: { uid: string; email: string; username: string },
): UserProfileRecord {
  return {
    uid: typeof value.uid === "string" ? value.uid : fallback.uid,
    email: typeof value.email === "string" ? value.email : fallback.email,
    username: typeof value.username === "string" && value.username.trim() ? value.username : fallback.username,
    active: value.active === true,
    device_id: typeof value.device_id === "string" && value.device_id.trim() ? value.device_id : null,
    role: value.role === "admin" ? "admin" : "viewer",
    subscription_expiry: value.subscription_expiry instanceof Timestamp ? value.subscription_expiry : null,
    created_at: value.created_at instanceof Timestamp ? value.created_at : null,
    updated_at: value.updated_at instanceof Timestamp ? value.updated_at : null,
  };
}

async function requireCurrentUser() {
  const user = getClientAuth().currentUser;

  if (!user) {
    throw new Error("Authentication required.");
  }

  return user;
}

async function syncUserProfileRecord(user: User, preferredUsername?: string): Promise<UserProfileRecord> {
  const ref = userDoc(user.uid);
  const snapshot = await getDoc(ref);
  const fallbackUsername = buildFallbackUsername(preferredUsername?.trim() || user.displayName?.trim(), user.email);

  if (!snapshot.exists()) {
    const profile: UserProfileRecord = {
      uid: user.uid,
      email: user.email ?? "",
      username: fallbackUsername,
      active: false,
      device_id: null,
      role: "viewer",
      subscription_expiry: null,
      created_at: null,
      updated_at: null,
    };

    await setDoc(ref, {
      uid: profile.uid,
      email: profile.email,
      username: profile.username,
      active: false,
      device_id: null,
      role: "viewer",
      subscription_expiry: null,
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    });

    return profile;
  }

  return mapUserProfile(snapshot.data() as Record<string, unknown>, {
    uid: user.uid,
    email: user.email ?? "",
    username: fallbackUsername,
  });
}

async function ensureUserProfile(preferredUsername?: string): Promise<UserProfileRecord> {
  const user = await requireCurrentUser();
  return syncUserProfileRecord(user, preferredUsername);
}

async function waitForSignedInUser(uid: string): Promise<void> {
  const auth = getClientAuth();

  if (auth.currentUser?.uid === uid) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out while establishing the new account session."));
    }, 8_000);

    const unsubscribe = onAuthStateChanged(
      auth,
      (user) => {
        if (user?.uid !== uid) {
          return;
        }

        window.clearTimeout(timeoutId);
        unsubscribe();
        resolve();
      },
      (error) => {
        window.clearTimeout(timeoutId);
        unsubscribe();
        reject(error);
      },
    );
  });
}

function shouldFallbackToClientRegistration(error: unknown) {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code === "functions/not-found" || error.code === "functions/unavailable";
  }

  return error instanceof Error
    ? error.message.includes("functions/not-found") || error.message.includes("functions/unavailable")
    : false;
}

async function registerViewerAccountDirect(input: {
  email: string;
  password: string;
  username: string;
}) {
  const auth = getClientAuth();
  const credential = await createUserWithEmailAndPassword(auth, input.email, input.password);

  try {
    await waitForSignedInUser(credential.user.uid);
    await credential.user.getIdToken(true);
    await updateProfile(credential.user, {
      displayName: input.username,
    });
    await syncUserProfileRecord(credential.user, input.username);

    return {
      username: input.username,
    };
  } catch (error) {
    try {
      await deleteUser(credential.user);
    } catch {
      await signOut(auth).catch(() => undefined);
      const message = error instanceof Error ? error.message : "Unable to create the profile record.";
      throw new Error(
        `${message} The sign-in account was created but the Firestore profile could not be saved. Delete that auth user before retrying the same email.`,
      );
    }

    throw error;
  }
}

async function requireAdminProfile(): Promise<UserProfileRecord> {
  const profile = await ensureUserProfile();

  if (profile.role !== "admin") {
    throw new Error("Admin access required.");
  }

  return profile;
}

function mapCategoryDocument(id: string, data: Record<string, unknown>) {
  return {
    id,
    name: typeof data.name === "string" ? data.name : "",
    parentId: typeof data.parentId === "number" ? data.parentId : 0,
  };
}

function mapChannelDocument(id: string, data: Record<string, unknown>) {
  return {
    id,
    name: typeof data.name === "string" ? data.name : "",
    categoryId: typeof data.categoryId === "string" ? data.categoryId : "",
    logo: typeof data.logo === "string" && data.logo ? data.logo : null,
    streamUrl: typeof data.streamUrl === "string" ? normalizeLiveStreamUrl(data.streamUrl) : "",
    epgChannelId: typeof data.epgChannelId === "string" && data.epgChannelId ? data.epgChannelId : null,
  };
}

function mapIptvSettings(data: Record<string, unknown> | undefined): IptvSettings {
  return {
    baseUrl: typeof data?.baseUrl === "string" ? data.baseUrl : "",
    username: typeof data?.username === "string" ? data.username : "",
    password: typeof data?.password === "string" ? data.password : "",
    updatedAtMs: toMillis(data?.updatedAt),
  };
}

function sanitizeBaseUrl(value: string): string {
  const trimmed = value.trim();

  if (!/^https?:\/\/.+/i.test(trimmed)) {
    throw new Error("Base URL must start with http:// or https://.");
  }

  return trimmed.replace(/\/$/, "");
}

function buildSummary(users: AdminUser[]): DashboardSummary {
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

function getIdentityToolkitErrorMessage(payload: IdentityToolkitErrorPayload, fallback: string) {
  const message = payload.error?.message;

  switch (message) {
    case "EMAIL_EXISTS":
      return "A user with this email already exists.";
    case "INVALID_EMAIL":
      return "Enter a valid email address.";
    case "WEAK_PASSWORD : Password should be at least 6 characters":
    case "WEAK_PASSWORD":
      return "Password must contain at least 6 characters.";
    default:
      return message ? message.replace(/_/g, " ") : fallback;
  }
}

function getCallableErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }

  return "";
}

function getCallableErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message;
  }

  return fallback;
}

async function createAuthUserFromAdmin(input: { email: string; password: string; username: string }) {
  const apiKey = getFirebaseWebConfig().apiKey;
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: input.email,
      password: input.password,
      returnSecureToken: true,
    }),
  });

  const payload = (await response.json()) as
    | IdentityToolkitErrorPayload
    | { localId: string; email: string; idToken?: string };

  if (!response.ok || !("localId" in payload)) {
    throw new Error(getIdentityToolkitErrorMessage(payload as IdentityToolkitErrorPayload, "Unable to create user."));
  }

  if (payload.idToken && input.username) {
    await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:update?key=${apiKey}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        idToken: payload.idToken,
        displayName: input.username,
        returnSecureToken: false,
      }),
    });
  }

  return {
    uid: payload.localId,
    email: payload.email,
  };
}

export async function syncViewerAccess(deviceId: string): Promise<ViewerSession> {
  let profile = await ensureUserProfile();
  let reason = getViewerReason(profile, deviceId);

  if (reason === "ok" && !profile.device_id) {
    await updateDoc(userDoc(profile.uid), {
      device_id: deviceId,
      updated_at: serverTimestamp(),
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
    isAdmin: profile.role === "admin",
    serverTimeMs: Date.now(),
    profile: mapViewerProfile(profile),
  };
}

export async function registerViewerAccount(input: {
  email: string;
  password: string;
  username: string;
}): Promise<{ username: string }> {
  const email = input.email.trim().toLowerCase();
  const password = input.password;
  const safeUsername = sanitizeUsername(input.username);

  if (!email || password.length < 6) {
    throw new Error("Email, password, and username are required.");
  }

  const registerCallable = httpsCallable<
    { email: string; password: string; username: string },
    { uid: string; username: string }
  >(getClientFunctions(), "registerViewerAccount");

  try {
    await registerCallable({
      email,
      password,
      username: safeUsername,
    });

    await signInWithEmailAndPassword(getClientAuth(), email, password);

    return {
      username: safeUsername,
    };
  } catch (error) {
    if (!shouldFallbackToClientRegistration(error)) {
      throw error;
    }

    return registerViewerAccountDirect({
      email,
      password,
      username: safeUsername,
    });
  }
}

export async function setUsername(username: string): Promise<{ username: string }> {
  const user = await requireCurrentUser();
  const safeUsername = sanitizeUsername(username);

  await Promise.all([
    updateProfile(user, {
      displayName: safeUsername,
    }),
    updateDoc(userDoc(user.uid), {
      username: safeUsername,
      updated_at: serverTimestamp(),
    }),
  ]);

  return {
    username: safeUsername,
  };
}

export async function getLiveCatalog(_deviceId: string, _forceRefresh = false): Promise<LiveCatalog> {
  await ensureUserProfile();

  const response = await fetch("/channels.json", {
    headers: { Accept: "application/json" },
    cache: _forceRefresh ? "no-cache" : "default",
  });

  if (!response.ok) {
    throw new Error(`Failed to load channel catalog (${response.status}).`);
  }

  const payload = (await response.json()) as LiveCatalog;

  // Normalize stream URLs and cache for setFavoriteChannel lookups
  const normalized: LiveCatalog = {
    generatedAtMs: payload.generatedAtMs ?? Date.now(),
    categories: payload.categories.map((item) => ({
      id: String(item.id ?? ""),
      name: String(item.name ?? ""),
      parentId: typeof item.parentId === "number" ? item.parentId : 0,
    })),
    channels: payload.channels.map((item) => ({
      id: String(item.id ?? ""),
      name: String(item.name ?? ""),
      categoryId: String(item.categoryId ?? ""),
      logo: typeof item.logo === "string" && item.logo ? item.logo : null,
      streamUrl: normalizeLiveStreamUrl(String(item.streamUrl ?? "")),
      epgChannelId: typeof item.epgChannelId === "string" && item.epgChannelId ? item.epgChannelId : null,
    })),
  };

  catalogCache = normalized;
  return normalized;
}

export async function getFavoriteChannels(_deviceId: string): Promise<FavoritesResponse> {
  const user = await requireCurrentUser();
  const snapshot = await getDocs(
    query(collection(getClientDb(), USERS_COLLECTION, user.uid, FAVORITES_COLLECTION), orderBy("added_at", "desc")),
  );

  return {
    favorites: snapshot.docs.map((item) => mapChannelDocument(item.id, item.data() as Record<string, unknown>)),
  };
}

export async function setFavoriteChannel(_deviceId: string, channelId: string): Promise<void> {
  const user = await requireCurrentUser();

  // Look up channel from cached catalog instead of Firestore
  const channel = catalogCache?.channels.find((item) => item.id === channelId);

  if (!channel) {
    throw new Error("Channel not found. Refresh the catalog and try again.");
  }

  await setDoc(favoriteDoc(user.uid, channelId), {
    ...channel,
    added_at: serverTimestamp(),
  });
}

export async function removeFavoriteChannel(_deviceId: string, channelId: string): Promise<void> {
  const user = await requireCurrentUser();
  await deleteDoc(favoriteDoc(user.uid, channelId));
}

export async function adminGetDashboard(): Promise<{ summary: DashboardSummary }> {
  const { users } = await adminListUsers();
  return {
    summary: buildSummary(users),
  };
}

export async function adminListUsers(): Promise<{ users: AdminUser[] }> {
  await requireAdminProfile();

  const snapshot = await getDocs(
    query(collection(getClientDb(), USERS_COLLECTION), orderBy("created_at", "desc"), limit(500)),
  );

  return {
    users: snapshot.docs.map((item) =>
      mapAdminUser(
        mapUserProfile(item.data() as Record<string, unknown>, {
          uid: item.id,
          email: "",
          username: item.id,
        }),
      ),
    ),
  };
}

export async function adminCreateUser(input: {
  email: string;
  password: string;
  username: string;
  active: boolean;
  subscriptionExpiryMs: number | null;
}): Promise<{ uid: string }> {
  await requireAdminProfile();

  const email = input.email.trim().toLowerCase();
  const password = input.password;
  const username = sanitizeUsername(input.username);

  if (!email || password.length < 6) {
    throw new Error("Email, password, and username are required.");
  }

  const authUser = await createAuthUserFromAdmin({
    email,
    password,
    username,
  });

  await setDoc(userDoc(authUser.uid), {
    uid: authUser.uid,
    email,
    username,
    active: Boolean(input.active),
    device_id: null,
    role: "viewer",
    subscription_expiry:
      input.subscriptionExpiryMs && input.subscriptionExpiryMs > 0
        ? Timestamp.fromMillis(input.subscriptionExpiryMs)
        : null,
    created_at: serverTimestamp(),
    updated_at: serverTimestamp(),
  });

  return {
    uid: authUser.uid,
  };
}

export async function adminUpdateUser(input: {
  uid: string;
  email?: string;
  username?: string;
  active?: boolean;
  subscriptionExpiryMs?: number | null;
}): Promise<void> {
  await requireAdminProfile();

  if (!input.uid) {
    throw new Error("User id is required.");
  }

  const updates: Record<string, unknown> = {
    updated_at: serverTimestamp(),
  };

  if (typeof input.username === "string" && input.username.trim()) {
    updates.username = sanitizeUsername(input.username);
  }

  if (typeof input.active === "boolean") {
    updates.active = input.active;
  }

  if ("subscriptionExpiryMs" in input) {
    updates.subscription_expiry =
      input.subscriptionExpiryMs && input.subscriptionExpiryMs > 0
        ? Timestamp.fromMillis(input.subscriptionExpiryMs)
        : null;
  }

  await updateDoc(userDoc(input.uid), updates);
}

export async function adminDeleteUser(uid: string): Promise<void> {
  await adminUpdateUser({
    uid,
    active: false,
    subscriptionExpiryMs: null,
  });
}

export async function adminResetDevice(uid: string): Promise<void> {
  await requireAdminProfile();

  if (!uid) {
    throw new Error("User id is required.");
  }

  await updateDoc(userDoc(uid), {
    device_id: null,
    updated_at: serverTimestamp(),
  });
}

export async function getAdminIptvSettings(): Promise<IptvSettings> {
  await requireAdminProfile();

  const snapshot = await getDoc(doc(getClientDb(), SYSTEM_COLLECTION, IPTV_SETTINGS_DOC));
  return mapIptvSettings(snapshot.data() as Record<string, unknown> | undefined);
}

export async function updateAdminIptvSettings(input: {
  baseUrl: string;
  username: string;
  password: string;
}): Promise<IptvSettings> {
  await requireAdminProfile();

  const nextSettings: IptvSettings = {
    baseUrl: sanitizeBaseUrl(input.baseUrl),
    username: input.username.trim(),
    password: input.password.trim(),
    updatedAtMs: Date.now(),
  };

  if (!nextSettings.username || !nextSettings.password) {
    throw new Error("Username and password are required.");
  }

  await setDoc(doc(getClientDb(), SYSTEM_COLLECTION, IPTV_SETTINGS_DOC), {
    baseUrl: nextSettings.baseUrl,
    username: nextSettings.username,
    password: nextSettings.password,
    updatedAt: serverTimestamp(),
  });

  return nextSettings;
}

export async function adminUpdateIptvEnv(): Promise<{ success: boolean; message?: string; envPath?: string }> {
  await requireAdminProfile();

  const updateEnvCallable = httpsCallable(getClientFunctions(), "adminUpdateIptvEnv");

  try {
    const result = await updateEnvCallable({});
    return result.data as { success: boolean; message?: string; envPath?: string };
  } catch (error) {
    const code = getCallableErrorCode(error);

    if (
      code === "functions/not-found" ||
      code === "functions/unimplemented" ||
      code === "functions/internal" ||
      code === "functions/unavailable"
    ) {
      return {
        success: false,
        message:
          "Settings were saved in Firestore, but the backend IPTV env/catalog sync is not available right now.",
      };
    }

    throw new Error(getCallableErrorMessage(error, "Unable to sync IPTV environment."));
  }
}

