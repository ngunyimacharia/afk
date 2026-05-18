import { mkdirSync } from 'node:fs';
import path from 'node:path';

const directory = path.resolve('dist', 'bin');
mkdirSync(directory, { recursive: true });

const executableName = process.platform === 'win32' ? 'afk.exe' : 'afk';
const outputPath = path.join(directory, executableName);
const build = Bun.spawnSync(['bun', 'build', './src/bin.ts', '--compile', '--outfile', outputPath], {
  stdout: 'inherit',
  stderr: 'inherit',
});

if (build.exitCode !== 0) process.exit(build.exitCode);

console.log(`Built ${outputPath}`);
