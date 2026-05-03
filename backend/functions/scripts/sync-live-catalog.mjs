import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";
import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "../../..");
const envFilePath = resolve(rootDir, "backend/functions/.env");
const serviceAccountPath = resolve(rootDir, "backend/functions/serviceAccountKey.json");
const webPublicDir = resolve(rootDir, "web/public");

loadDotenv({ path: envFilePath, override: true });

const channelNameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function getRequiredEnv(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }

  return value;
}

function getLocalEnvIptvConfig() {
  const baseUrl = process.env.XTREAM_BASE_URL?.trim() ?? "";
  const username = process.env.XTREAM_USERNAME?.trim() ?? "";
  const password = process.env.XTREAM_PASSWORD?.trim() ?? "";

  if (!baseUrl || !username || !password) {
    return null;
  }

  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    username,
    password,
  };
}

function applyIptvConfig(config) {
  process.env.XTREAM_BASE_URL = config.baseUrl;
  process.env.XTREAM_USERNAME = config.username;
  process.env.XTREAM_PASSWORD = config.password;
}

function normalizeLabel(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
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

async function loadFirestoreIptvConfig() {
  try {
    const projectId = await resolveProjectId();

    if (getApps().length === 0) {
      const credential = existsSync(serviceAccountPath)
        ? cert(JSON.parse(await readFile(serviceAccountPath, "utf8")))
        : applicationDefault();

      initializeApp({
        credential,
        projectId,
      });
    }

    const snapshot = await getFirestore().collection("system").doc("iptv_config").get();

    if (!snapshot.exists) {
      return null;
    }

    const data = snapshot.data() ?? {};
    const baseUrl = typeof data.baseUrl === "string" ? data.baseUrl.trim() : "";
    const username = typeof data.username === "string" ? data.username.trim() : "";
    const password = typeof data.password === "string" ? data.password.trim() : "";

    if (!baseUrl || !username || !password) {
      return null;
    }

    return {
      baseUrl: baseUrl.replace(/\/$/, ""),
      username,
      password,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Unable to read IPTV settings from Firestore. Falling back to local .env. ${message}`);
    return null;
  }
}

let authFailed = false;

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`IPTV request failed (${response.status}) for ${url}`);
  }

  const data = await response.json();

  if (data && typeof data === "object" && !Array.isArray(data) && "user_info" in data) {
    const userInfo = data.user_info;

    if (userInfo?.status === "Banned") {
      console.error("ERROR: Account is BANNED by the provider.");
      authFailed = true;
      return [];
    }

    if (userInfo?.auth !== 1) {
      console.error("ERROR: Authentication failed. Check credentials.");
      authFailed = true;
      return [];
    }

    return [];
  }

  return data;
}

const localEnvConfig = getLocalEnvIptvConfig();

if (localEnvConfig) {
  applyIptvConfig(localEnvConfig);
  console.log(`Loaded IPTV settings from ${envFilePath}.`);
} else {
  const firestoreConfig = await loadFirestoreIptvConfig();

  if (firestoreConfig) {
    applyIptvConfig(firestoreConfig);
    console.log("Loaded IPTV settings from Firestore for this sync run.");
  }
}

const baseUrl = getRequiredEnv("XTREAM_BASE_URL").replace(/\/$/, "");
const username = getRequiredEnv("XTREAM_USERNAME");
const password = getRequiredEnv("XTREAM_PASSWORD");

console.log(`Base URL: ${baseUrl}`);
console.log(`Username: ${username}`);

const categoriesPayload = await fetchJson(
  `${baseUrl}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_live_categories`,
);

const streamsPayload = await fetchJson(
  `${baseUrl}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_live_streams`,
);

if (authFailed) {
  console.error("\nFailed to sync. The Xtream Codes account appears to be banned or invalid.");
  console.error("Please check your credentials or contact your IPTV provider.");
  process.exit(1);
}

const categoriesRaw = Array.isArray(categoriesPayload) ? categoriesPayload : [];
const streamsRaw = Array.isArray(streamsPayload) ? streamsPayload : [];

const categories = [];
const seenCategoryIds = new Set();

for (const item of categoriesRaw) {
  const id = String(item?.category_id ?? "").trim();
  const name = normalizeLabel(item?.category_name);

  if (!id || !name || seenCategoryIds.has(id)) {
    continue;
  }

  seenCategoryIds.add(id);
  categories.push({
    id,
    name,
    parentId: Number(item?.parent_id ?? 0),
  });
}

const validCategoryIds = new Set(categories.map((category) => category.id));
const channelMap = new Map();

for (const item of streamsRaw) {
  const streamType = typeof item?.stream_type === "string" ? item.stream_type.toLowerCase() : "";
  const categoryId = String(item?.category_id ?? "").trim();
  const streamId = String(item?.stream_id ?? "").trim();
  const name = normalizeLabel(item?.name);

  if (!validCategoryIds.has(categoryId)) {
    continue;
  }

  if (streamType && streamType !== "live") {
    continue;
  }

  if (!streamId || !name) {
    continue;
  }

  const nextChannel = {
    id: streamId,
    name,
    categoryId,
    logo: typeof item?.stream_icon === "string" && item.stream_icon.trim() ? item.stream_icon.trim() : null,
    streamUrl: `${baseUrl}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${encodeURIComponent(streamId)}.m3u8`,
    epgChannelId:
      typeof item?.epg_channel_id === "string" && item.epg_channel_id.trim() ? item.epg_channel_id.trim() : null,
  };

  const existingChannel = channelMap.get(streamId);

  if (!existingChannel || (!existingChannel.logo && nextChannel.logo)) {
    channelMap.set(streamId, nextChannel);
  }
}

const channels = Array.from(channelMap.values()).sort((left, right) =>
  channelNameCollator.compare(left.name, right.name),
);
const categoriesWithChannels = new Set(channels.map((channel) => channel.categoryId));
const filteredCategories = categories.filter((category) => categoriesWithChannels.has(category.id));

const catalog = {
  generatedAtMs: Date.now(),
  categories: filteredCategories,
  channels,
};

await writeFile(resolve(webPublicDir, "channels.json"), JSON.stringify(catalog, null, 2), "utf8");

console.log(
  `Synced ${filteredCategories.length} categories and ${channels.length} live channels to web/public/channels.json.`,
);
