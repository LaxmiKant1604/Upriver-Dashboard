// Test-only side-effect module: ensure isSupabaseConfigured() is true so serveSharedReport takes its shared-store
// READ path (which uses ONLY injected readers -- no network). Imported FIRST (before lib/server/supabase.js loads)
// so the module-level SUPABASE_URL / SUPABASE_SECRET_KEY consts capture these values. Never overrides real creds.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost/supabase-stub";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "stub-service-role-key";
