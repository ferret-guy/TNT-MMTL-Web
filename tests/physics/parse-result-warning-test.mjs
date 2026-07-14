#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseResult } from '../../src/solver/parseResult.mjs';

test('asterisk report separators do not become empty warnings', () => {
  const result = parseResult(`
**********
***
*** useful solver warning
Warning: explicit warning
  `);

  assert.deepEqual(result.warnings, [
    'useful solver warning',
    'Warning: explicit warning',
  ]);
});
