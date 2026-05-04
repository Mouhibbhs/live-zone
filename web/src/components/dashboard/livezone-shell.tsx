"use client";

import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import Image from "next/image";
import { Download, LayoutGrid, LogOut, Radio, RefreshCw, Shield } from "lucide-react";
import { useEffect, useState } from "react";

import { AuthScreen } from "@/components/auth/auth-screen";
import {
  getFavoriteChannels,
  getLiveCatalog,
  removeFavoriteChannel,
  setFavoriteChannel,
  setUsername,
  syncViewerAccess,
} from "@/lib/api";
import { getBrowserDeviceId } from "@/lib/browser-device";
import { getClientAuth } from "@/lib/firebase";
import type { LiveCatalog, LiveChannel, ViewerSession } from "@/lib/types";

import { AdminDashboard } from "./admin-dashboard";
import { ViewerDashboard } from "./viewer-dashboard";

type ViewMode = "viewer" | "admin";

const CATALOG_CACHE_KEY = "livezone_web_catalog";
const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unexpected request failure.";
}

function readCachedCatalog(): LiveCatalog | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(CATALOG_CACHE_KEY);

  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as LiveCatalog;
    if (Date.now() - parsed.generatedAtMs > CATALOG_CACHE_TTL_MS) {
      window.localStorage.removeItem(CATALOG_CACHE_KEY);
      return null;
    }

    return parsed;
  } catch {
    window.localStorage.removeItem(CATALOG_CACHE_KEY);
    return null;
  }
}

function persistCatalog(catalog: LiveCatalog) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify(catalog));
}

export function LiveZoneShell() {
  const [authLoading, setAuthLoading] = useState(true);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [deviceId, setDeviceId] = useState("");
  const [session, setSession] = useState<ViewerSession | null>(null);
  const [catalog, setCatalog] = useState<LiveCatalog | null>(null);
  const [favorites, setFavorites] = useState<LiveChannel[]>([]);
  const [requestBusy, setRequestBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("viewer");

  async function loadViewerWorkspace(_user: User, nextDeviceId: string, forceRefresh = false) {
    setRequestBusy(true);
    setError(null);

    try {
      const viewerSession = await syncViewerAccess(nextDeviceId);
      setSession(viewerSession);
      setIsAdmin(viewerSession.isAdmin);

      if (viewerSession.allowed) {
        const cachedCatalog = forceRefresh ? null : readCachedCatalog();

        if (cachedCatalog) {
          setCatalog(cachedCatalog);
        }

        const [freshCatalog, favoritesResponse] = await Promise.all([
          cachedCatalog ? Promise.resolve(cachedCatalog) : getLiveCatalog(nextDeviceId, forceRefresh),
          getFavoriteChannels(nextDeviceId),
        ]);

        setCatalog(freshCatalog);
        persistCatalog(freshCatalog);
        setFavorites(favoritesResponse.favorites);
        setViewMode("viewer");
      } else {
        setCatalog(null);
        setFavorites([]);
        if (viewerSession.isAdmin) {
          setViewMode("admin");
        }
      }
    } catch (loadError) {
      setError(getErrorMessage(loadError));
      setCatalog(null);
      setFavorites([]);
      if (isAdmin) {
        setViewMode("admin");
      }
    } finally {
      setRequestBusy(false);
    }
  }

  useEffect(() => {
    try {
      const auth = getClientAuth();
      const unsubscribe = onAuthStateChanged(auth, async (user) => {
        setCurrentUser(user);
        setError(null);

        if (!user) {
          setAuthLoading(false);
          setIsAdmin(false);
          setSession(null);
          setCatalog(null);
          setFavorites([]);
          return;
        }

        const nextDeviceId = getBrowserDeviceId();

        setAuthLoading(false);
        setDeviceId(nextDeviceId);
        await loadViewerWorkspace(user, nextDeviceId);
      });

      return () => unsubscribe();
    } catch (setupError) {
      setError(getErrorMessage(setupError));
      setAuthLoading(false);
      return undefined;
    }
  }, []);

  async function refreshWorkspace(forceRefresh = true) {
    if (!currentUser || !deviceId) {
      return;
    }

    await loadViewerWorkspace(currentUser, deviceId, forceRefresh);
  }

  async function handleToggleFavorite(channelId: string, favorite: boolean) {
    if (!deviceId) {
      return;
    }

    setError(null);

    try {
      if (favorite) {
        await removeFavoriteChannel(deviceId, channelId);
      } else {
        await setFavoriteChannel(deviceId, channelId);
      }

      const response = await getFavoriteChannels(deviceId);
      setFavorites(response.favorites);
    } catch (toggleError) {
      setError(getErrorMessage(toggleError));
    }
  }

  async function handleSaveUsername(username: string) {
    try {
      const response = await setUsername(username);
      setSession((current) =>
        current && current.profile
          ? {
              ...current,
              profile: {
                ...current.profile,
                username: response.username,
              },
            }
          : current,
      );
    } catch (saveError) {
      setError(getErrorMessage(saveError));
    }
  }

  async function handleSignOut() {
    await signOut(getClientAuth());
  }

  if (authLoading) {
    return (
      <main className="splash-screen">
        <Image alt="LiveZone" height={160} priority src="/logo.png" width={160} />
        <p>Connecting to LiveZone...</p>
      </main>
    );
  }

  if (!currentUser) {
    return (
      <>
        {error ? <div className="error-banner auth-error-banner">{error}</div> : null}
        <AuthScreen onError={setError} />
      </>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-brand">
          <Image alt="LiveZone" height={56} priority src="/logo.png" width={56} />
          <div>
            <p className="eyebrow">LiveZone</p>
            <strong>Live IPTV Control Surface</strong>
          </div>
        </div>

        <div className="topbar-actions">
          <button
            className={viewMode === "viewer" ? "secondary-button active" : "secondary-button"}
            onClick={() => setViewMode("viewer")}
            type="button"
          >
            <Radio size={16} />
            Viewer
          </button>

          {isAdmin ? (
            <button
              className={viewMode === "admin" ? "secondary-button active" : "secondary-button"}
              onClick={() => setViewMode("admin")}
              type="button"
            >
              <Shield size={16} />
              Admin
            </button>
          ) : null}

          <button className="secondary-button" onClick={() => void refreshWorkspace(true)} type="button">
            <RefreshCw size={16} />
            {requestBusy ? "Syncing..." : "Sync"}
          </button>

          <a className="secondary-button mobile-download-link" download href="/livezone-mobile.apk">
            <Download size={16} />
            Get mobile app
          </a>

          <button className="secondary-button" onClick={handleSignOut} type="button">
            <LogOut size={16} />
            Sign out
          </button>
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      <section className="workspace-shell">
        {viewMode === "viewer" ? (
          <ViewerDashboard
            catalog={catalog}
            favorites={favorites}
            onRefresh={() => refreshWorkspace(true)}
            onSaveUsername={handleSaveUsername}
            onToggleFavorite={handleToggleFavorite}
            refreshing={requestBusy}
            session={session}
          />
        ) : isAdmin ? (
          <AdminDashboard />
        ) : (
          <section className="blocked-state">
            <div className="blocked-panel">
              <LayoutGrid size={24} />
              <div>
                <h2>Admin access required</h2>
                <p>This account does not have admin access.</p>
              </div>
            </div>
          </section>
        )}
      </section>
    </main>
  );
}
