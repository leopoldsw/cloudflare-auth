import { performance } from "node:perf_hooks";

import { hashPassword } from "../packages/core/src/index.js";

const samples: number[] = [];
for (let i = 0; i < 3; i += 1) {
  await hashPassword("benchmark password", { profile: "development-fast" });
}
for (let i = 0; i < 10; i += 1) {
  const started = performance.now();
  await hashPassword("benchmark password", { profile: "development-fast" });
  samples.push(performance.now() - started);
}

samples.sort((a, b) => a - b);
const p50 = samples[Math.floor(samples.length * 0.5)] ?? 0;
const p95 = samples[Math.floor(samples.length * 0.95)] ?? samples.at(-1) ?? 0;
console.log(
  JSON.stringify(
    {
      profile: "development-fast",
      p50Ms: Math.round(p50),
      p95Ms: Math.round(p95),
    },
    null,
    2,
  ),
);
