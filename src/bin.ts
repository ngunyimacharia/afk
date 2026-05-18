import { runAfk } from './cli.js';

const result = await runAfk();

if (result.message) console.log(result.message);
process.exitCode = result.code;
