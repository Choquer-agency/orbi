import { app } from 'electron';
import fs from 'fs';
import path from 'path';

type Schema = {
  windowBounds: { width: number; height: number; x?: number; y?: number };
  isMaximized: boolean;
  autoLaunch: boolean;
};

const defaults: Schema = {
  windowBounds: { width: 1400, height: 900 },
  isMaximized: false,
  autoLaunch: false,
};

function storePath(): string {
  return path.join(app.getPath('userData'), 'orbi-prefs.json');
}

function read(): Schema {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return { ...defaults };
  }
}

function write(data: Schema): void {
  try {
    fs.writeFileSync(storePath(), JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to persist prefs:', err);
  }
}

let cache: Schema | null = null;

export const store = {
  get<K extends keyof Schema>(key: K): Schema[K] {
    if (!cache) cache = read();
    return cache[key];
  },
  set<K extends keyof Schema>(key: K, value: Schema[K]): void {
    if (!cache) cache = read();
    cache[key] = value;
    write(cache);
  },
};
