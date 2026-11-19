// Small helpers shared by the benchmark scripts.
const fs = require('fs');
const os = require('os');
const path = require('path');

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

function stats(values) {
  const sum = values.reduce((a, b) => a + b, 0);
  const round = (n) => (n === null ? null : Math.round(n * 1000) / 1000);
  return {
    n: values.length,
    mean: round(values.length ? sum / values.length : null),
    p50: round(percentile(values, 50)),
    p95: round(percentile(values, 95)),
    max: round(values.length ? Math.max(...values) : null)
  };
}

function environment() {
  return {
    node: process.version,
    platform: `${process.platform} ${os.release()}`,
    cpu: (os.cpus()[0] || {}).model || 'unknown',
    cpus: os.cpus().length,
    date: new Date().toISOString()
  };
}

function writeResult(name, data) {
  const dir = path.join(__dirname, '..', '..', 'docs', 'benchmark-results');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ environment: environment(), ...data }, null, 2) + '\n');
  return file;
}

// Deterministic PRNG (mulberry32) so mixed workloads are reproducible.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { percentile, stats, environment, writeResult, prng };
