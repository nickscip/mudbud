import "react-native-url-polyfill/auto";

import { createClient } from "@supabase/supabase-js";

/**
 * Read-only client for the glaze catalog.
 *
 * The glaze lookup is the app's first networked feature — process capture stays entirely
 * on-device in SQLite and must keep working offline. Nothing here touches that path.
 *
 * No session persistence: every query runs as the anon role against read-only RLS
 * policies, so there is nothing to store and no reason to pull in AsyncStorage.
 */
const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? "";
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "";

export const glazeCatalogConfigured = Boolean(url && anonKey);

export const supabase = createClient(url || "http://localhost", anonKey || "anon", {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
