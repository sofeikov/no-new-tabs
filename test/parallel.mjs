// Parallel test runner: splits the run.mjs STEPS table into shards and runs
// each shard as its own `node test/run.mjs` worker (own browser profiles,
// own static server on its own PORT). Coverage is identical to a full run:
// same steps, same assertions — only the orchestration is concurrent.
//
//   node test/parallel.mjs [shards]     (default: SHARDS env or 6)
//   node test/parallel.mjs 0-8,9-15     (explicit `first-last` step ranges)
//
// Each worker gets TEST_ONLY=<index:id,...> and PORT=<base+shard>. The
// parent streams worker output prefixed with the shard number and exits
// nonzero if any shard fails.
import { spawn } from "node:child_process";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const STEP_COUNT = 31;
const BASE_PORT = Number(process.env.PORT ?? 8799);

// Default partition, tuned from measured per-step times (see profile notes
// in this file): balanced so every shard finishes within seconds of the
// others on a many-core machine.
const DEFAULT_PARTITION = [
  [0, 2], // Playwright: options page, blocked mode, blocked sanity (~120 s)
  [3, 8], // Playwright: control mode + untouched/adoption/survive (~135 s)
  [9, 15], // raw CDP, full extension (~45 s)
  [16, 19], // raw CDP, full extension, popup blocker off (~30 s)
  [20, 20], // background layer only: blocked-mode run (~110 s)
  [21, 30], // background layer only: the rest + popup chain (~70 s)
];

function parsePartition(argv) {
  if (argv.length) {
    return argv.flatMap((a) => a.split(",")).map((r) => {
      const m = /^(\d+)-(\d+)$/.exec(r.trim());
      if (!m) throw new Error(`bad range: ${r} (want first-last)`);
      return [Number(m[1]), Number(m[2])];
    });
  }
  const n = Math.max(1, Math.min(STEP_COUNT, Number(process.env.SHARDS ?? 6)));
  if (n === DEFAULT_PARTITION.length) return DEFAULT_PARTITION;
  // Fall back to contiguous even slices for any other shard count.
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push([Math.floor((i * STEP_COUNT) / n), Math.floor(((i + 1) * STEP_COUNT) / n) - 1]);
  }
  return out.filter(([a, b]) => a <= b);
}

const partition = parsePartition(process.argv.slice(2));
const maxWorkers = Math.max(1, Math.min(partition.length, cpus().length));
console.log(`parallel: ${partition.length} shards on ${maxWorkers} workers (base port ${BASE_PORT})`);

const results = await Promise.all(partition.map(([first, last], shard) =>
  new Promise((resolve) => {
    const ids = [];
    for (let i = first; i <= last; i++) ids.push(i);
    const env = { ...process.env, TEST_ONLY: ids.map((i) => `${i}:`).join(","), PORT: String(BASE_PORT + shard) };
    // TEST_ONLY matches `index:id` prefixes, so `i:` selects step i exactly.
    const child = spawn(process.execPath, [join(here, "run.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const tag = (d) => { output += d; for (const line of String(d).split("\n")) if (line.trim()) console.log(`[s${shard}] ${line}`); };
    child.stdout.on("data", tag);
    child.stderr.on("data", tag);
    child.on("close", (code) => {
      const m = output.match(/(\d+ FAILED|ALL PASSED)\s*$/m);
      resolve({ shard, first, last, code, summary: m ? m[1] : `exit ${code}` });
    });
  }),
));

let failed = 0;
for (const r of results) {
  console.log(`shard ${r.shard} (steps ${r.first}-${r.last}): ${r.summary}`);
  if (r.code !== 0) failed++;
}
process.exit(failed ? 1 : 0);
