import "react-native-url-polyfill/auto";

import { createClient } from "@supabase/supabase-js";

/**
 * Read-only client for the glaze catalog.
 *
 * The glaze lookup is the app's first networked feature — process capture stays entirely
 * on-device in SQLite and must keep working offline. Nothing here touches that path.
 *
 * Uses the **publishable** key (`sb_publishable_...`), which is what Supabase now calls the
 * key formerly labelled `anon`. It is designed to ship inside a client bundle: it grants only
 * what the row-level security policies allow, which here is SELECT on the catalog tables and
 * nothing else. The *secret* key is its counterpart and must never appear in the app — it
 * bypasses RLS entirely and belongs only to the ETL.
 *
 * No session persistence: every query runs unauthenticated against read-only policies, so
 * there is nothing to store and no reason to pull in AsyncStorage.
 */
const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? "";
const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";

export const glazeCatalogConfigured = Boolean(url && publishableKey);

export const supabase = createClient(url || "http://localhost", publishableKey || "unset", {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
