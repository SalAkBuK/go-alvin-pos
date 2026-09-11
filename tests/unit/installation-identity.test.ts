import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INSTALLATION_ID_PATTERN,
  loadOrCreateInstallationId,
} from '../../src/main/app/installationIdentity';

describe('installation identity', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gpp-installation-'));
    filePath = join(dir, 'nested', 'installation-id');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('generates and persists one non-personal installation ID', () => {
    const installationId = loadOrCreateInstallationId(filePath);

    expect(installationId).toMatch(INSTALLATION_ID_PATTERN);
    expect(readFileSync(filePath, 'utf8').trim()).toBe(installationId);
  });

  it('returns the same ID after reopen/restart without generating another', () => {
    const firstId = 'INST-12345678-1234-4123-8123-123456789ABC';
    const createId = vi.fn(() => firstId);
    expect(loadOrCreateInstallationId(filePath, createId)).toBe(firstId);

    const afterRestart = loadOrCreateInstallationId(filePath, createId);
    expect(afterRestart).toBe(firstId);
    expect(createId).toHaveBeenCalledTimes(1);
  });
});
