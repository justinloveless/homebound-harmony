import { describe, expect, test } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { replayEvents } from '@/lib/events';
import { migrateWorkspace } from '@/lib/storage';
import type { Workspace } from '@/types/models';
import type { Event } from '@/types/events';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', '..', 'specs', 'event-fixtures');

function loadFixtureFile(filePath: string): {
  name: string;
  snapshotBefore: Workspace;
  events: Event[];
  snapshotAfter: Workspace;
} {
  const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  return {
    name: path.basename(filePath),
    snapshotBefore: migrateWorkspace(raw.snapshotBefore as Workspace),
    events: raw.events as Event[],
    snapshotAfter: migrateWorkspace(raw.snapshotAfter as Workspace),
  };
}

describe('specs/event-fixtures', () => {
  const jsonFiles = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json'));

  test.each(jsonFiles)('%s replays to snapshotAfter', (filename) => {
    const { snapshotBefore, events, snapshotAfter } = loadFixtureFile(path.join(FIXTURES_DIR, filename));
    const out = replayEvents(snapshotBefore, events);
    expect(out).toEqual(snapshotAfter);
  });
});
