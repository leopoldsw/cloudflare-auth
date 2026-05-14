import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PasswordBenchmarkParams {
  N: number;
  r: number;
  p: number;
  keyLen: number;
  maxmem: number;
}

export interface PasswordBenchmarkResult<ProfileName extends string = string> {
  profile: ProfileName;
  runtime: "workers-local";
  warmupHashes: number;
  measuredHashes: number;
  p50Ms: number;
  p95Ms: number;
  throughputHashesPerSecond: number;
}

export interface WorkersPasswordBenchmarkInput<
  ProfileName extends string = string,
> {
  profile: ProfileName;
  params: PasswordBenchmarkParams;
  timeoutMs?: number;
  wranglerCommand?: string;
}

const benchmarkCompatibilityDate = "2026-05-13";

export async function runWorkersPasswordBenchmark<
  ProfileName extends string = string,
>(
  input: WorkersPasswordBenchmarkInput<ProfileName>,
): Promise<PasswordBenchmarkResult<ProfileName>> {
  const tempDir = await mkdtemp(join(tmpdir(), "cf-auth-password-benchmark-"));
  const port = await findOpenPort();
  const origin = `http://127.0.0.1:${port}`;
  await writeFile(
    join(tempDir, "wrangler.jsonc"),
    JSON.stringify(
      {
        name: "cf-auth-password-benchmark",
        main: "worker.mjs",
        compatibility_date: benchmarkCompatibilityDate,
        compatibility_flags: ["nodejs_compat"],
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    join(tempDir, "worker.mjs"),
    benchmarkWorkerSource(input.profile, input.params),
  );

  const dev = spawn(
    input.wranglerCommand ?? "wrangler",
    [
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--show-interactive-dev-session=false",
      "--log-level",
      "error",
    ],
    {
      cwd: tempDir,
      env: { ...process.env, CI: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  let spawnError: Error | null = null;
  dev.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  dev.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  dev.on("error", (error) => {
    spawnError = error;
  });

  try {
    const result = await fetchBenchmarkResult<ProfileName>({
      origin,
      dev,
      output: () => output,
      spawnError: () => spawnError,
      timeoutMs: input.timeoutMs ?? 120_000,
    });
    if (result.profile !== input.profile) {
      throw new Error("Password benchmark returned the wrong profile");
    }
    return result;
  } finally {
    await stopDevServer(dev);
    await rm(tempDir, { recursive: true, force: true });
  }
}

function benchmarkWorkerSource(
  profile: string,
  params: PasswordBenchmarkParams,
): string {
  return `import { randomBytes, scrypt as scryptCallback } from "node:crypto";

const profile = ${JSON.stringify(profile)};
const params = ${JSON.stringify(params)};
const password = "correct horse battery staple benchmark";
const warmupHashes = 3;
const measuredHashes = 10;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/benchmark") return new Response("ok");
    const result = await runBenchmark();
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" }
    });
  }
};

async function runBenchmark() {
  const samples = [];
  for (let index = 0; index < warmupHashes; index += 1) {
    await hashOnce();
  }
  const measuredStarted = performance.now();
  for (let index = 0; index < measuredHashes; index += 1) {
    const started = performance.now();
    await hashOnce();
    samples.push(performance.now() - started);
  }
  const measuredMs = performance.now() - measuredStarted;
  samples.sort((a, b) => a - b);
  const p50 = percentile(samples, 0.5);
  const p95 = percentile(samples, 0.95);
  const throughput = measuredMs > 0 ? measuredHashes / (measuredMs / 1000) : 0;
  return {
    profile,
    runtime: "workers-local",
    warmupHashes,
    measuredHashes,
    p50Ms: Math.round(p50),
    p95Ms: Math.round(p95),
    throughputHashesPerSecond: Math.round(throughput * 100) / 100
  };
}

function percentile(samples, value) {
  return samples[Math.min(samples.length - 1, Math.floor(samples.length * value))] ?? 0;
}

async function hashOnce() {
  const salt = randomBytes(16);
  await scryptWithParams(password, salt);
}

function scryptWithParams(value, salt) {
  return new Promise((resolve, reject) => {
    scryptCallback(
      value,
      salt,
      params.keyLen,
      { N: params.N, r: params.r, p: params.p, maxmem: params.maxmem },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      }
    );
  });
}
`;
}

async function fetchBenchmarkResult<ProfileName extends string>(input: {
  origin: string;
  dev: ChildProcess;
  output: () => string;
  spawnError: () => Error | null;
  timeoutMs: number;
}): Promise<PasswordBenchmarkResult<ProfileName>> {
  const deadline = Date.now() + input.timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const spawnError = input.spawnError();
    if (spawnError) throw spawnError;
    if (input.dev.exitCode !== null || input.dev.signalCode !== null) {
      throw new Error(`wrangler dev exited early:\n${input.output()}`);
    }
    try {
      const response = await fetch(`${input.origin}/benchmark`);
      if (response.ok) {
        return parseBenchmarkResult<ProfileName>(await response.text());
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  const detail =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `Timed out waiting for password benchmark: ${detail}\n${input.output()}`,
  );
}

function parseBenchmarkResult<ProfileName extends string>(
  text: string,
): PasswordBenchmarkResult<ProfileName> {
  const parsed = JSON.parse(text) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("profile" in parsed) ||
    typeof parsed.profile !== "string" ||
    !("runtime" in parsed) ||
    parsed.runtime !== "workers-local" ||
    !("warmupHashes" in parsed) ||
    typeof parsed.warmupHashes !== "number" ||
    !("measuredHashes" in parsed) ||
    typeof parsed.measuredHashes !== "number" ||
    !("p50Ms" in parsed) ||
    typeof parsed.p50Ms !== "number" ||
    !("p95Ms" in parsed) ||
    typeof parsed.p95Ms !== "number" ||
    !("throughputHashesPerSecond" in parsed) ||
    typeof parsed.throughputHashesPerSecond !== "number"
  ) {
    throw new Error("Password benchmark returned an invalid result");
  }
  return parsed as PasswordBenchmarkResult<ProfileName>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findOpenPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolvePort(address.port);
        else reject(new Error("Could not allocate local port"));
      });
    });
  });
}

async function stopDevServer(dev: ChildProcess): Promise<void> {
  if (dev.exitCode !== null || dev.signalCode !== null) return;
  await new Promise<void>((resolveStop) => {
    const killTimer = setTimeout(() => {
      if (dev.exitCode === null && dev.signalCode === null) {
        dev.kill("SIGKILL");
      }
    }, 2_000);
    killTimer.unref();
    dev.once("close", () => {
      clearTimeout(killTimer);
      resolveStop();
    });
    dev.kill();
  });
}
