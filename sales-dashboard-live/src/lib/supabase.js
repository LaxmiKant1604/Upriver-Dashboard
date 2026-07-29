import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY;
const browserStorage = typeof window === "undefined" ? undefined : window.localStorage;

export const supabase = url && publishableKey
  ? createClient(url, publishableKey, {
    auth: {
      // Use an explicit first-party browser store. This keeps the Supabase
      // refresh token available when the dashboard page is reloaded.
      storage: browserStorage,
      storageKey: "upriver-dashboard-auth-v1",
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  })
  : null;
