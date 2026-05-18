import { accessSync, constants, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function isWritableDirectory(directory: string): boolean {
  try {
    accessSync(directory, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function pathEntries(): string[] {
  return (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
}

function usablePathEntries(): string[] {
  const projectRoot = path.resolve(import.meta.dir, '..');
  return pathEntries()
    .map((entry) => path.resolve(entry))
    .filter((entry) => !entry.includes(`${path.sep}node_modules${path.sep}.bin`))
    .filter((entry) => !entry.startsWith(path.join(projectRoot, 'node_modules')));
}

function defaultUserBin(): string {
  if (process.platform === 'win32') return path.join(os.homedir(), 'bin');
  return path.join(os.homedir(), '.local', 'bin');
}

function installDirectory(): string {
  if (process.env.AFK_INSTALL_DIR) return path.resolve(process.env.AFK_INSTALL_DIR);

  const home = os.homedir();
  const entries = usablePathEntries();
  const preferred = [
    ...(process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : []),
    ...(process.platform === 'win32' ? [] : [path.join(home, '.local', 'bin')]),
    path.join(home, 'bin'),
  ];
  const preferredPath = preferred.find((entry) => entries.includes(path.resolve(entry)) && isWritableDirectory(entry));
  if (preferredPath) return preferredPath;

  const writableUserPath = entries.find((entry) => entry.startsWith(home) && isWritableDirectory(entry));
  return writableUserPath ?? defaultUserBin();
}

const directory = installDirectory();
mkdirSync(directory, { recursive: true });

const executableName = process.platform === 'win32' ? 'afk.exe' : 'afk';
const outputPath = path.join(directory, executableName);
const build = Bun.spawnSync(['bun', 'build', './src/bin.ts', '--compile', '--outfile', outputPath], {
  stdout: 'inherit',
  stderr: 'inherit',
});

if (build.exitCode !== 0) process.exit(build.exitCode);

console.log(`Installed ${outputPath}`);

if (!usablePathEntries().includes(path.resolve(directory))) {
  console.log(`Add ${directory} to PATH before running afk from a new shell.`);
}
