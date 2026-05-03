"use client";

import {
  Clock3,
  Heart,
  Menu,
  RefreshCw,
  Search,
  ShieldCheck,
  Tv2,
  UserRound,
  X,
} from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useState } from "react";

import type { LiveCatalog, LiveChannel, ViewerSession } from "@/lib/types";

import { StreamPlayer } from "./stream-player";

interface ViewerDashboardProps {
  session: ViewerSession | null;
  catalog: LiveCatalog | null;
  favorites: LiveChannel[];
  refreshing: boolean;
  onRefresh: () => Promise<void>;
  onSaveUsername: (username: string) => Promise<void>;
  onToggleFavorite: (channelId: string, favorite: boolean) => Promise<void>;
}

type ActiveDrawer = "channels" | "favorites" | null;

function reasonLabel(reason: ViewerSession["reason"] | undefined) {
  switch (reason) {
    case "inactive":
      return "Your account exists, but it is inactive. An admin needs to activate the subscription.";
    case "expired":
      return "Your subscription has expired. Renew the plan to restore live TV access.";
    case "device_mismatch":
      return "This account is tied to another device. Ask an admin to reset the device lock.";
    case "profile_missing":
      return "Your account is still being provisioned. Refresh in a moment.";
    default:
      return "Live access is currently unavailable.";
  }
}

function getQualityBadge(channel: LiveChannel, categoryName?: string) {
  const label = `${channel.name} ${categoryName ?? ""}`.toLowerCase();

  if (label.includes("4k") || label.includes("uhd")) {
    return "4K";
  }

  if (label.includes("h265") || label.includes("hevc")) {
    return "H265";
  }

  if (label.includes("sd")) {
    return "SD";
  }

  if (label.includes("fhd") || label.includes("1080")) {
    return "FHD";
  }

  return "HD";
}

export function ViewerDashboard({
  session,
  catalog,
  favorites,
  refreshing,
  onRefresh,
  onSaveUsername,
  onToggleFavorite,
}: ViewerDashboardProps) {
  const [query, setQuery] = useState("");
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [activeDrawer, setActiveDrawer] = useState<ActiveDrawer>(null);
  const [usernameDraft, setUsernameDraft] = useState(session?.profile?.username ?? "");
  const [savingUsername, setSavingUsername] = useState(false);
  const deferredQuery = useDeferredValue(query);

  useEffect(() => {
    setUsernameDraft(session?.profile?.username ?? "");
  }, [session?.profile?.username]);

  const favoriteIds = useMemo(() => new Set(favorites.map((channel) => channel.id)), [favorites]);
  const categoryLookup = useMemo(
    () => new Map((catalog?.categories ?? []).map((category) => [category.id, category.name])),
    [catalog?.categories],
  );

  const normalizedQuery = deferredQuery.trim().toLowerCase();

  const filteredFavoriteChannels = useMemo(
    () =>
      favorites
        .filter((channel) => channel.name.toLowerCase().includes(normalizedQuery))
        .sort((left, right) =>
          left.name.localeCompare(right.name, undefined, {
            numeric: true,
            sensitivity: "base",
          }),
        ),
    [favorites, normalizedQuery],
  );

  const groupedChannels = useMemo(() => {
    if (!catalog) {
      return [];
    }

    return catalog.categories
      .map((category) => ({
        id: category.id,
        name: category.name,
        channels: catalog.channels
          .filter(
            (channel) =>
              channel.categoryId === category.id &&
              (!normalizedQuery || channel.name.toLowerCase().includes(normalizedQuery)),
          )
          .sort((left, right) =>
            left.name.localeCompare(right.name, undefined, {
              numeric: true,
              sensitivity: "base",
            }),
          ),
      }))
      .filter((group) => group.channels.length > 0);
  }, [catalog, normalizedQuery]);

  useEffect(() => {
    if (!catalog || catalog.channels.length === 0) {
      setSelectedChannelId(null);
      return;
    }

    if (selectedChannelId && catalog.channels.some((channel) => channel.id === selectedChannelId)) {
      return;
    }

    setSelectedChannelId(favorites[0]?.id || catalog.channels[0]?.id || null);
  }, [catalog, favorites, selectedChannelId]);

  const selectedChannel =
    catalog?.channels.find((channel) => channel.id === selectedChannelId) ||
    favorites.find((channel) => channel.id === selectedChannelId) ||
    null;

  const selectedCategoryName = selectedChannel ? categoryLookup.get(selectedChannel.categoryId) || "Live" : "Live";
  const expiryLabel = session?.profile?.subscriptionExpiryMs
    ? new Date(session.profile.subscriptionExpiryMs).toLocaleString()
    : "Not scheduled";
  const selectedIsFavorite = selectedChannel ? favoriteIds.has(selectedChannel.id) : false;
  const visibleChannelCount = groupedChannels.reduce((count, group) => count + group.channels.length, 0);

  function toggleDrawer(drawer: Exclude<ActiveDrawer, null>) {
    setActiveDrawer((current) => (current === drawer ? null : drawer));
  }

  function handleSelectChannel(channelId: string) {
    setSelectedChannelId(channelId);
    setActiveDrawer(null);
  }

  async function handleSaveUsername() {
    if (!usernameDraft.trim()) {
      return;
    }

    setSavingUsername(true);
    try {
      await onSaveUsername(usernameDraft.trim());
    } finally {
      setSavingUsername(false);
    }
  }

  if (!session?.allowed) {
    return (
      <section className="blocked-state">
        <div className="blocked-panel">
          <ShieldCheck size={26} />
          <div>
            <h2>Viewer access is blocked</h2>
            <p>{reasonLabel(session?.reason)}</p>
          </div>
          <button className="secondary-button" onClick={() => void onRefresh()} type="button">
            <RefreshCw size={16} />
            Refresh status
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="viewer-grid">
      <div className="status-strip">
        <div className="stat-card">
          <Clock3 size={18} />
          <div>
            <span>Subscription</span>
            <strong>{expiryLabel}</strong>
          </div>
        </div>

        <div className="stat-card">
          <Tv2 size={18} />
          <div>
            <span>Channels</span>
            <strong>{catalog?.channels.length ?? 0} live streams</strong>
          </div>
        </div>

        <div className="stat-card">
          <Heart size={18} />
          <div>
            <span>Favorites</span>
            <strong>{favorites.length} pinned channels</strong>
          </div>
        </div>
      </div>

      <div className="viewer-shell">
        <div className="viewer-toolbar">
          <div className="viewer-toolbar-copy">
            <p className="eyebrow">Live Room</p>
            <h2>{selectedChannel?.name ?? "Pick a live channel"}</h2>
            <p>
              {selectedChannel
                ? `${selectedCategoryName} • tuned for adaptive HLS playback with automatic live-edge recovery.`
                : "Open the channel drawer to launch a stream and pin your favorites for fast access."}
            </p>
          </div>

          <div className="viewer-toolbar-actions">
            <button
              className={activeDrawer === "channels" ? "secondary-button active" : "secondary-button"}
              onClick={() => toggleDrawer("channels")}
              type="button"
            >
              <Menu size={16} />
              Channels
            </button>

            <button
              className={activeDrawer === "favorites" ? "secondary-button active" : "secondary-button"}
              onClick={() => toggleDrawer("favorites")}
              type="button"
            >
              <Heart size={16} />
              Favorites
            </button>

            <button className="secondary-button" onClick={() => void onRefresh()} type="button">
              <RefreshCw size={16} />
              {refreshing ? "Syncing..." : "Refresh"}
            </button>
          </div>
        </div>

        <div className="viewer-layout">
          <div className="viewer-stage-main">
            <StreamPlayer channel={selectedChannel} />
          </div>

          <aside className="viewer-stage-sidebar">
            <div className="selected-channel-card">
              <div className="selected-channel-head">
                {selectedChannel?.logo ? (
                  <img alt={selectedChannel.name} className="selected-channel-logo" src={selectedChannel.logo} />
                ) : (
                  <div className="selected-channel-logo fallback">
                    <Tv2 size={18} />
                  </div>
                )}

                <div className="selected-channel-copy">
                  <span className="eyebrow">Now Playing</span>
                  <strong>{selectedChannel?.name ?? "No channel selected"}</strong>
                  <p>{selectedChannel ? selectedCategoryName : "Choose a stream from the drawer to begin playback."}</p>
                </div>
              </div>

              <div className="selected-channel-actions">
                <button className="secondary-button" onClick={() => toggleDrawer("channels")} type="button">
                  <Menu size={16} />
                  Browse channels
                </button>

                {selectedChannel ? (
                  <button
                    className={selectedIsFavorite ? "secondary-button active" : "secondary-button"}
                    onClick={() => void onToggleFavorite(selectedChannel.id, selectedIsFavorite)}
                    type="button"
                  >
                    <Heart fill={selectedIsFavorite ? "currentColor" : "none"} size={16} />
                    {selectedIsFavorite ? "Pinned" : "Pin channel"}
                  </button>
                ) : null}
              </div>

              <div className="selected-channel-grid">
                <div className="mini-stat-card">
                  <span>Visible now</span>
                  <strong>{visibleChannelCount}</strong>
                </div>

                <div className="mini-stat-card">
                  <span>Pinned</span>
                  <strong>{favorites.length}</strong>
                </div>
              </div>
            </div>

            <div className="profile-panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Profile</p>
                  <h3>{session.profile?.email}</h3>
                </div>
              </div>

              <div className="inline-form">
                <label className="field compact">
                  <span>Username</span>
                  <div className="input-shell">
                    <UserRound size={18} />
                    <input onChange={(event) => setUsernameDraft(event.target.value)} value={usernameDraft} />
                  </div>
                </label>

                <button className="secondary-button" disabled={savingUsername} onClick={handleSaveUsername} type="button">
                  {savingUsername ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          </aside>
        </div>

        <button
          aria-label="Close drawer"
          className={activeDrawer ? "viewer-drawer-backdrop active" : "viewer-drawer-backdrop"}
          onClick={() => setActiveDrawer(null)}
          type="button"
        />

        <aside className={activeDrawer === "channels" ? "viewer-drawer open" : "viewer-drawer"} aria-hidden={activeDrawer !== "channels"}>
          <div className="drawer-header">
            <div>
              <p className="eyebrow">Channel Drawer</p>
              <strong>Browse live channels</strong>
            </div>

            <button className="icon-button" onClick={() => setActiveDrawer(null)} type="button">
              <X size={16} />
            </button>
          </div>

          <div className="search-shell drawer-search">
            <Search size={18} />
            <input onChange={(event) => setQuery(event.target.value)} placeholder="Search channels or favorites" value={query} />
          </div>

          <div className="drawer-meta-row">
            <span>{visibleChannelCount} matching channels</span>
            <span>{favorites.length} pinned</span>
          </div>

          <div className="drawer-list">
            {filteredFavoriteChannels.length > 0 ? (
              <div className="channel-group-block">
                <span className="group-label">Pinned first</span>

                {filteredFavoriteChannels.map((channel) => {
                  const isFavorite = favoriteIds.has(channel.id);

                  return (
                    <div className={selectedChannelId === channel.id ? "channel-list-row active" : "channel-list-row"} key={`favorite-${channel.id}`}>
                      <button className="channel-list-main" onClick={() => handleSelectChannel(channel.id)} type="button">
                        <span className="channel-list-name">{channel.name}</span>
                        <span className="quality-badge">{getQualityBadge(channel, "Favorites")}</span>
                      </button>

                      <button
                        aria-label="Remove from favorites"
                        className={isFavorite ? "sidebar-favorite-btn active" : "sidebar-favorite-btn"}
                        onClick={() => void onToggleFavorite(channel.id, isFavorite)}
                        type="button"
                      >
                        <Heart fill={isFavorite ? "currentColor" : "none"} size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : null}

            {groupedChannels.map((group) => (
              <div className="channel-group-block" key={group.id}>
                <span className="group-label">{group.name}</span>

                {group.channels.map((channel) => {
                  const isFavorite = favoriteIds.has(channel.id);

                  return (
                    <div className={selectedChannelId === channel.id ? "channel-list-row active" : "channel-list-row"} key={channel.id}>
                      <button className="channel-list-main" onClick={() => handleSelectChannel(channel.id)} type="button">
                        <span className="channel-list-name">{channel.name}</span>
                        <span className="quality-badge">{getQualityBadge(channel, group.name)}</span>
                      </button>

                      <button
                        aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
                        className={isFavorite ? "sidebar-favorite-btn active" : "sidebar-favorite-btn"}
                        onClick={() => void onToggleFavorite(channel.id, isFavorite)}
                        type="button"
                      >
                        <Heart fill={isFavorite ? "currentColor" : "none"} size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </aside>

        <aside
          className={activeDrawer === "favorites" ? "viewer-drawer viewer-drawer-right open" : "viewer-drawer viewer-drawer-right"}
          aria-hidden={activeDrawer !== "favorites"}
        >
          <div className="drawer-header">
            <div>
              <p className="eyebrow">Pinned Drawer</p>
              <strong>Favorite channels</strong>
            </div>

            <button className="icon-button" onClick={() => setActiveDrawer(null)} type="button">
              <X size={16} />
            </button>
          </div>

          <div className="search-shell drawer-search">
            <Search size={18} />
            <input onChange={(event) => setQuery(event.target.value)} placeholder="Filter favorites" value={query} />
          </div>

          <div className="drawer-meta-row">
            <span>{filteredFavoriteChannels.length} matches</span>
            <span>{favorites.length} total pinned</span>
          </div>

          <div className="favorites-list">
            {filteredFavoriteChannels.length === 0 ? (
              <p className="muted-copy">Pin channels from the channel drawer and they will appear here for one-tap access.</p>
            ) : null}

            {filteredFavoriteChannels.map((channel) => (
              <button
                className={selectedChannelId === channel.id ? "favorite-row active" : "favorite-row"}
                key={channel.id}
                onClick={() => handleSelectChannel(channel.id)}
                type="button"
              >
                <span>{channel.name}</span>
                <span className="favorite-row-meta">{categoryLookup.get(channel.categoryId) || "Live"}</span>
              </button>
            ))}
          </div>
        </aside>
      </div>
    </section>
  );
}
