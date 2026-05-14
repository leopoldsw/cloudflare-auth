# Password Benchmark

The benchmark script measures the configured password profile in a temporary
Wrangler local Worker with three warm-up hashes and ten measured hashes. It
defaults to `workers-balanced`, matching generated production-ready config.

Run on May 14, 2026 with Node v26.0.0 and Wrangler's local Workers runtime:

```json
{
  "profile": "workers-balanced",
  "runtime": "workers-local",
  "warmupHashes": 3,
  "measuredHashes": 10,
  "p50Ms": 31,
  "p95Ms": 32,
  "throughputHashesPerSecond": 32.26
}
```

Run it locally after changing password parameters:

```bash
pnpm benchmark:password
pnpm benchmark:password -- --profile development-fast
```

Production deployments should use `workers-balanced` unless they have measured CPU budget and latency headroom for a higher-cost profile.
