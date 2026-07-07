import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const directory = path.resolve('dist', 'bin');
mkdirSync(directory, { recursive: true });

const packageJson = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as { version?: string };
const packageVersion = packageJson.version ?? '0.0.0';

const executableName = process.platform === 'win32' ? 'afk.exe' : 'afk';
const outputPath = path.join(directory, executableName);
const build = Bun.spawnSync(
  [
    'bun',
    'build',
    './src/bin.ts',
    '--compile',
    '--outfile',
    outputPath,
    '--define',
    `process.env.AFK_VERSION=${JSON.stringify(packageVersion)}`,
  ],
  {
    stdout: 'inherit',
    stderr: 'inherit',
  },
);

if (build.exitCode !== 0) process.exit(build.exitCode);

console.log(`Built ${outputPath} (version ${packageVersion})`);
