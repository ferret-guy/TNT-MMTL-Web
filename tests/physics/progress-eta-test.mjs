import assert from 'node:assert/strict';
import test from 'node:test';
import { ProgressEta, formatEta } from '../../src/solver/progressEta.ts';

test('ETA starts immediately, predicts a steady rate, and completes exactly', () => {
  const eta = new ProgressEta(0);
  eta.update(.01, 100);
  assert.equal(eta.remainingSeconds(100), .99);
  for (let t = 200; t <= 3000; t += 100) eta.update(t / 10000, t);
  assert.ok(Math.abs(eta.remainingSeconds(3000) - 7) < 1e-9);
  eta.update(1, 10000);
  assert.equal(eta.remainingSeconds(10000), 0);
});

test('ETA adapts to sustained slowdown and keeps its estimate visible during pauses', () => {
  const eta = new ProgressEta(0);
  for (let t = 100; t <= 3000; t += 100) eta.update(t / 10000, t);
  for (let t = 3100; t <= 6000; t += 100) eta.update(.3 + (t - 3000) / 20000, t);
  const remaining = eta.remainingSeconds(6000);
  assert.ok(remaining > 7 && remaining < 11);
  assert.equal(eta.remainingSeconds(12000), remaining);
  eta.update(.46, 12100);
  assert.ok(Number.isFinite(eta.remainingSeconds(12100)));
});

test('ETA handles callback batching, invalid updates, and restarting', () => {
  const fast = new ProgressEta(0), batched = new ProgressEta(0);
  for (let t = 10; t <= 3000; t += 10) fast.update(t / 10000, t);
  for (let t = 500; t <= 3000; t += 500) batched.update(t / 10000, t);
  assert.ok(Math.abs(fast.remainingSeconds(3000) - batched.remainingSeconds(3000)) < 1e-9);
  fast.update(NaN, 3100);
  assert.ok(Number.isFinite(fast.remainingSeconds(3100)));
  assert.equal(new ProgressEta(3100, 84).remainingSeconds(3100), 84);
  assert.match(formatEta(null), /Estimating/);
  assert.equal(formatEta(61), '1 min 1 s left');
});
