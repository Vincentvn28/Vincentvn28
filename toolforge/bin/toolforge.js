#!/usr/bin/env node
import { main } from '../src/cli/cli.js';

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
