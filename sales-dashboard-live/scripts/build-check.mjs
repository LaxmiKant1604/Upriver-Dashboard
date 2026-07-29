// Build verification that actually compiles the dashboard.
//
// WHY THIS EXISTS: src/lib/supabase.js exports `supabase` as null when
// VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY are absent, and App.jsx
// returns an early "Login setup incomplete" screen in that case. Vite inlines
// import.meta.env at build time, so in a workspace without those variables
// Rollup proves `supabase` is null and dead-code-eliminates LoginScreen,
// DashboardApp, every report view, recharts and lucide-react. A plain
// `npm run build` then "passes" while compiling almost none of the app: the
// output is ~180 kB with no chunk-size warning instead of ~930 kB with one.
//
// This script injects harmless placeholder PUBLIC values (never secrets, never
// written to disk) purely so the whole component tree is compiled and type/
// syntax errors in the dashboard actually surface. The artifact it produces is
// for verification only — deployments get their real values from Vercel.

import { spawnSync } from "node:child_process";

const PLACEHOLDER_ENV = {
  VITE_SUPABASE_URL: "https://build-check.invalid",
  VITE_SUPABASE_PUBLISHABLE_KEY: "build-check-publishable-key",
  VITE_SUPABASE_ANON_KEY: "build-check-anon-key",
};

const injected = Object.entries(PLACEHOLDER_ENV)
  .filter(([key]) => !process.env[key])
  .map(([key]) => key);

if (injected.length) {
  console.log(`build-check: injecting placeholder values for ${injected.join(", ")} so the full app compiles.`);
} else {
  console.log("build-check: using the Vite public variables already present in the environment.");
}

// A single command string with shell:true and no separate args, so Node does
// not warn about unescaped argument concatenation.
const result = spawnSync("npx vite build", {
  stdio: "inherit",
  shell: true,
  env: { ...PLACEHOLDER_ENV, ...process.env },
});

if (result.status !== 0) process.exit(result.status ?? 1);

console.log("\nbuild-check: complete. A bundle noticeably smaller than ~900 kB, or the absence of the >500 kB chunk warning, means the dashboard was tree-shaken away and the build did NOT verify it.");
