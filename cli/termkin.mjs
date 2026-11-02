#!/usr/bin/env node
import { run } from './core.mjs';

// Keep stdout usable when an agent pipes a result into a consumer that exits early.
process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});
process.exitCode = await run(process.argv.slice(2));
