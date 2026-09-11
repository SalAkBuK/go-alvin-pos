import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const INSTALLATION_ID_PATTERN =
  /^INST-[0-9A-F]{8}-[0-9A-F]{4}-[1-5][0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/;

export function generateInstallationId(): string {
  return `INST-${randomUUID().toUpperCase()}`;
}

function readInstallationId(filePath: string): string {
  const value = readFileSync(filePath, 'utf8').trim();
  if (!INSTALLATION_ID_PATTERN.test(value)) {
    throw new Error('The local installation identifier is invalid.');
  }
  return value;
}

/** Load the non-personal identity, creating it exactly once in pinned app data. */
export function loadOrCreateInstallationId(
  filePath: string,
  createId: () => string = generateInstallationId,
): string {
  try {
    return readInstallationId(filePath);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw error;
    }
  }

  mkdirSync(dirname(filePath), { recursive: true });
  const generated = createId();
  if (!INSTALLATION_ID_PATTERN.test(generated)) {
    throw new Error('The generated installation identifier is invalid.');
  }

  try {
    writeFileSync(filePath, `${generated}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return generated;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      return readInstallationId(filePath);
    }
    throw error;
  }
}
