#!/usr/bin/env node
/**
 * Test Runner — runs all test suites in order.
 *
 * Usage:
 *   node tests/run.mjs              # run all tests
 *   node tests/run.mjs --fast       # skip integration tests (API calls)
 *   node tests/run.mjs --verbose    # verbose output for integration tests
 *
 * Exit code: 0 if all pass, 1 if any fail.
 *
 * Test categories:
 *   FAST   — typecheck, lint (no API calls, no cost)
 *   INTEGRATION — search regression, summarizer eval (API calls, ~$0.25/run)
 */

import { execSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const FRONTEND = join(ROOT, "frontend");

const args = process.argv.slice(2);
const FAST_ONLY = args.includes("--fast");
const VERBOSE = args.includes("--verbose");
const INCLUDE_E2E = args.includes("--e2e");

// ── Test Suite Definitions ─────────────────────────────

const FAST_TESTS = [
  {
    name: "TypeScript",
    cmd: "npx tsc --noEmit",
    cwd: FRONTEND,
  },
  {
    name: "ESLint (source only)",
    cmd: "npx eslint lib/ app/ components/ --max-warnings 50",
    cwd: FRONTEND,
  },
];

const INTEGRATION_TESTS = [
  {
    name: "Search Regression",
    cmd: `node tests/search.test.mjs${VERBOSE ? " --verbose" : ""}`,
    cwd: ROOT,
    envRequired: ["OPENAI_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"],
  },
  {
    name: "Summarizer Eval",
    cmd: `node tests/summarizer.test.mjs${VERBOSE ? " --verbose" : ""}`,
    cwd: ROOT,
    envRequired: ["OPENAI_API_KEY"],
    dataRequired: "data/cases_parsed/apofaseised/oik/2024/2320240403.md",
  },
];

const E2E_TESTS = [
  {
    name: "E2E Pipeline",
    cmd: `node tests/e2e.test.mjs${VERBOSE ? " --verbose" : ""}`,
    cwd: ROOT,
    envRequired: ["OPENAI_API_KEY"],
  },
];

// ── Runner ─────────────────────────────────────────────

function run(test) {
  // Check env vars
  if (test.envRequired) {
    const missing = test.envRequired.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      console.log(`  SKIP — missing env: ${missing.join(", ")}`);
      return "skip";
    }
  }

  // Check data files
  if (test.dataRequired) {
    try {
      execSync(`test -f "${join(ROOT, test.dataRequired)}"`, { stdio: "pipe" });
    } catch {
      console.log(`  SKIP — missing data: ${test.dataRequired}`);
      return "skip";
    }
  }

  try {
    execSync(test.cmd, {
      cwd: test.cwd,
      stdio: "inherit",
      env: { ...process.env },
    });
    return "pass";
  } catch {
    return "fail";
  }
}

// ── Main ───────────────────────────────────────────────

const results = [];

console.log(`\n${"═".repeat(60)}`);
console.log(`  TEST RUNNER${FAST_ONLY ? " (fast only)" : ""}`);
console.log(`${"═".repeat(60)}\n`);

// Fast tests
console.log("── Fast checks ──\n");
for (const test of FAST_TESTS) {
  process.stdout.write(`  ${test.name}... `);
  const t0 = Date.now();
  const result = run(test);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (result === "pass") {
    console.log(`\r  ✓ ${test.name} (${elapsed}s)`);
  } else if (result === "skip") {
    // already printed skip reason
  } else {
    console.log(`\r  ✗ ${test.name} FAILED (${elapsed}s)`);
  }
  results.push({ name: test.name, result, category: "fast" });
}

// Integration tests
if (!FAST_ONLY) {
  console.log("\n── Integration tests ──\n");
  for (const test of INTEGRATION_TESTS) {
    console.log(`  ${test.name}:`);
    const t0 = Date.now();
    const result = run(test);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    if (result === "pass") {
      console.log(`  ✓ ${test.name} passed (${elapsed}s)\n`);
    } else if (result === "skip") {
      console.log();
    } else {
      console.log(`  ✗ ${test.name} FAILED (${elapsed}s)\n`);
    }
    results.push({ name: test.name, result, category: "integration" });
  }
}

// E2E tests (only with --e2e flag)
if (INCLUDE_E2E) {
  console.log("\n── E2E pipeline tests ──\n");
  for (const test of E2E_TESTS) {
    console.log(`  ${test.name}:`);
    const t0 = Date.now();
    const result = run(test);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    if (result === "pass") {
      console.log(`  ✓ ${test.name} passed (${elapsed}s)\n`);
    } else if (result === "skip") {
      console.log();
    } else {
      console.log(`  ✗ ${test.name} FAILED (${elapsed}s)\n`);
    }
    results.push({ name: test.name, result, category: "e2e" });
  }
}

// Summary
const passed = results.filter((r) => r.result === "pass").length;
const failed = results.filter((r) => r.result === "fail").length;
const skipped = results.filter((r) => r.result === "skip").length;

console.log(`${"═".repeat(60)}`);
const icon = failed === 0 ? "✓" : "✗";
console.log(`  ${icon} ${passed} passed, ${failed} failed, ${skipped} skipped`);
console.log(`${"═".repeat(60)}\n`);

process.exit(failed > 0 ? 1 : 0);
