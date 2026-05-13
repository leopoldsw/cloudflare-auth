# Password Benchmark

The benchmark script measures the default `development-fast` profile with warmup iterations before sampling.

Run on May 13, 2026 with Node v26.0.0:

```json
{
  "profile": "development-fast",
  "p50Ms": 25,
  "p95Ms": 29
}
```

Run it locally after changing password parameters:

```bash
pnpm benchmark:password
```

Production deployments should use `workers-balanced` unless they have measured CPU budget and latency headroom for a higher-cost profile.
