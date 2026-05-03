import { HttpsError } from "firebase-functions/v2/https";

import { MemoryCache } from "./cache.js";
import type { LiveCatalogDto, LiveCategoryDto, LiveChannelDto } from "./types.js";

const catalogCache = new MemoryCache<LiveCatalogDto>(5 * 60 * 1000);

function getXtreamConfig() {
  const baseUrl = process.env.XTREAM_BASE_URL?.trim();
  const username = process.env.XTREAM_USERNAME?.trim();
  const password = process.env.XTREAM_PASSWORD?.trim();

  if (!baseUrl || !username || !password) {
    throw new HttpsError("failed-precondition", "Missing IPTV environment configuration.");
  }

  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    username,
    password,
  };
}

function buildPlayerApiUrl(action: string) {
  const { baseUrl, username, password } = getXtreamConfig();
  const params = new URLSearchParams({
    username,
    password,
    action,
  });

  return `${baseUrl}/player_api.php?${params.toString()}`;
}

function buildStreamUrl(streamId: number | string): string {
  const { baseUrl, username, password } = getXtreamConfig();
  return `${baseUrl}/live/${username}/${password}/${streamId}.ts`;
}

async function fetchXtreamJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new HttpsError("unavailable", `IPTV provider request failed with status ${response.status}.`);
  }

  return (await response.json()) as T;
}

export async function loadLiveCatalog(forceRefresh = false): Promise<LiveCatalogDto> {
  if (!forceRefresh) {
    const cached = catalogCache.get("live-catalog");

    if (cached) {
      return cached;
    }
  }

  const [categoriesPayload, streamsPayload] = await Promise.all([
    fetchXtreamJson<Array<{ category_id: number | string; category_name: string; parent_id?: number }>>(
      buildPlayerApiUrl("get_live_categories"),
    ),
    fetchXtreamJson<
      Array<{
        stream_id: number;
        name: string;
        category_id: number | string;
        stream_icon?: string;
        epg_channel_id?: string;
        stream_type?: string;
      }>
    >(buildPlayerApiUrl("get_live_streams")),
  ]);

  const categories: LiveCategoryDto[] = categoriesPayload
    .map((item) => ({
      id: String(item.category_id),
      name: item.category_name,
      parentId: item.parent_id ?? 0,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  const validCategoryIds = new Set(categories.map((category) => category.id));

  const channels: LiveChannelDto[] = streamsPayload
    .filter((item) => {
      const streamType = item.stream_type?.toLowerCase();
      return validCategoryIds.has(String(item.category_id)) && (!streamType || streamType === "live");
    })
    .map((item) => ({
      id: String(item.stream_id),
      name: item.name,
      categoryId: String(item.category_id),
      logo: item.stream_icon || null,
      epgChannelId: item.epg_channel_id || null,
      streamUrl: buildStreamUrl(item.stream_id),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  const catalog: LiveCatalogDto = {
    generatedAtMs: Date.now(),
    categories,
    channels,
  };

  return catalogCache.set("live-catalog", catalog);
}
