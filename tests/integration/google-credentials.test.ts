import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGoogleCredentialStore } from '../../src/main/google/googleCredentialStore';
import { createGoogleConfigService } from '../../src/main/google/googleConfigService';
import { readGoogleSettings } from '../../src/main/settings/googleSettingsRepository';
import { isAppError } from '../../src/main/shared/appError';
import { createMigratedDb } from '../helpers/database';
import { seedBusiness, seedTaxRate } from '../helpers/checkout';
import {
  fakeAuthProvider,
  fakeSecureCrypto,
  fakeServiceAccountJson,
  FAKE_SERVICE_ACCOUNT,
} from '../helpers/google';

/**
 * Phase 2J — credential import / storage / generation / audit consistency
 * (`task §3`, `§4`, `§10`, `§28`; `POS_WORKFLOWS.md §71`-`§72`; `REQ-GSHEET-013`,
 * `REQ-AUDIT-002`). The real `googleCredentialStore` runs against a temp dir with
 * a fake `SecureCrypto` (reversible, deterministic — NOT real encryption).
 */

let db: Database.Database;
let dir: string;
let filePath: string;
let clock = Date.parse('2026-09-08T12:00:00.000Z');
const now = (): string => new Date(clock).toISOString();

function auditRows(): Array<Record<string, unknown>> {
  return db
    .prepare(
      "SELECT * FROM audit_events WHERE event_type = 'GOOGLE_CONFIGURATION_CHANGED' ORDER BY sequence",
    )
    .all() as Array<Record<string, unknown>>;
}

function makeService(cryptoAvailable = true, pickedPath: string | null = null) {
  const crypto = fakeSecureCrypto(cryptoAvailable);
  const credentialStore = createGoogleCredentialStore({ filePath, crypto });
  const service = createGoogleConfigService({
    db,
    appVersion: 't',
    credentialStore,
    pickCredentialFile: () => Promise.resolve(pickedPath),
    createAuthProvider: () => fakeAuthProvider(),
    now,
  });
  return { service, credentialStore, crypto };
}

beforeEach(async () => {
  clock = Date.parse('2026-09-08T12:00:00.000Z');
  db = await createMigratedDb();
  seedTaxRate(db);
  seedBusiness(db);
  dir = mkdtempSync(join(tmpdir(), 'gpp-gcred-'));
  filePath = join(dir, 'secrets', 'google-service-account.enc');
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('credential shape validation', () => {
  it('rejects non-service-account JSON, a bad email, a missing key, and a foreign token endpoint', () => {
    const { credentialStore } = makeService();
    for (const bad of [
      '{}',
      'not json',
      fakeServiceAccountJson({ type: 'authorized_user' }),
      fakeServiceAccountJson({ client_email: 'someone@example.com' }),
      fakeServiceAccountJson({ private_key: 'nope' }),
      fakeServiceAccountJson({ token_uri: 'https://evil.example/token' }),
      fakeServiceAccountJson({ universe_domain: 'evil.example' }),
    ]) {
      expect(() => credentialStore.parseAndValidate(bad)).toThrow();
    }
  });

  it('accepts a well-formed service account and keeps only the whitelisted fields', () => {
    const { credentialStore } = makeService();
    const parsed = credentialStore.parseAndValidate(
      fakeServiceAccountJson({
        extra_field: 'ignored',
        auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      }),
    );
    expect(parsed).toEqual({
      type: 'service_account',
      projectId: FAKE_SERVICE_ACCOUNT.projectId,
      clientEmail: FAKE_SERVICE_ACCOUNT.clientEmail,
      privateKey: FAKE_SERVICE_ACCOUNT.privateKey,
      privateKeyId: FAKE_SERVICE_ACCOUNT.privateKeyId,
      clientId: FAKE_SERVICE_ACCOUNT.clientId,
    });
    expect(JSON.stringify(parsed)).not.toContain('token_uri');
  });
});

describe('encrypted credential round trip', () => {
  it('write → load returns the same credential and generation, and the file is not plaintext', async () => {
    const { credentialStore } = makeService();
    await credentialStore.writeCredential(FAKE_SERVICE_ACCOUNT, 3);
    const loaded = await credentialStore.loadCredential();
    expect(loaded).toEqual({ generation: 3, credential: FAKE_SERVICE_ACCOUNT });
    const raw = readFileSync(filePath, 'utf8');
    // The fake crypto is a reversible marker; production is opaque DPAPI ciphertext.
    // What matters here: the file is not plain JSON on disk.
    expect(raw.startsWith('{')).toBe(false);
    expect(raw.startsWith('enc:')).toBe(true);
  });
});

describe('connect', () => {
  it('offline: validates, encrypts, persists generation + audit — no network', async () => {
    const keyFile = join(dir, 'key.json');
    writeFileSync(keyFile, fakeServiceAccountJson());
    const { service, credentialStore } = makeService(true, keyFile);

    const result = await service.connect();
    expect(result).toEqual({
      connected: true,
      serviceAccountEmail: FAKE_SERVICE_ACCOUNT.clientEmail,
      credentialGeneration: 1,
    });
    expect(readGoogleSettings(db).credentialGeneration).toBe(1);
    expect(await credentialStore.loadCredential()).toEqual({
      generation: 1,
      credential: FAKE_SERVICE_ACCOUNT,
    });
    const audits = auditRows();
    expect(audits).toHaveLength(1);
    const details = JSON.parse(audits[0]!['details_json'] as string) as Record<string, unknown>;
    expect(details['action']).toBe('CREDENTIAL_CONNECTED');
    expect(details['credentialGeneration']).toBe(1);
    expect(JSON.stringify(audits[0])).not.toContain('PRIVATE KEY');
  });

  it('rotate: a second connect bumps the generation and records CREDENTIAL_ROTATED', async () => {
    const keyFile = join(dir, 'key.json');
    writeFileSync(keyFile, fakeServiceAccountJson());
    const { service } = makeService(true, keyFile);
    await service.connect();
    const second = await service.connect();
    expect(second.credentialGeneration).toBe(2);
    expect(readGoogleSettings(db).credentialGeneration).toBe(2);
    const audits = auditRows();
    expect(audits).toHaveLength(2);
    expect((JSON.parse(audits[1]!['details_json'] as string) as { action: string }).action).toBe(
      'CREDENTIAL_ROTATED',
    );
  });

  it('secure storage unavailable → typed error, nothing written, no plaintext fallback', async () => {
    const { service, credentialStore } = makeService(false, join(dir, 'key.json'));
    writeFileSync(join(dir, 'key.json'), fakeServiceAccountJson());
    await expect(service.connect()).rejects.toMatchObject({
      code: 'GOOGLE_SECURE_STORAGE_UNAVAILABLE',
    });
    expect(credentialStore.fileExists()).toBe(false);
    expect(auditRows()).toHaveLength(0);
  });
});

describe('disconnect', () => {
  it('authority off in SQLite first, then the file is removed; audit recorded', async () => {
    const keyFile = join(dir, 'key.json');
    writeFileSync(keyFile, fakeServiceAccountJson());
    const { service, credentialStore } = makeService(true, keyFile);
    await service.connect();
    // also enable, to prove disconnect turns it off
    await service.updateConfig({
      enabled: true,
      spreadsheetId: 'abcdefghij1234567890',
      salesSheetName: 'Sales',
      saleItemsSheetName: 'Sale Items',
    });

    const config = await service.disconnect();
    expect(config.enabled).toBe(false);
    expect(config.connected).toBe(false);
    // Generation is monotonic — only the active flag flips.
    expect(readGoogleSettings(db).credentialGeneration).toBe(1);
    expect(readGoogleSettings(db).credentialActive).toBe(false);
    expect(credentialStore.fileExists()).toBe(false);
    const actions = auditRows().map(
      (r) => (JSON.parse(r['details_json'] as string) as { action: string }).action,
    );
    expect(actions).toContain('CREDENTIAL_DISCONNECTED');
  });
});

describe('startup reconciliation', () => {
  it('file generation ahead of SQLite (crash after file, before commit) → records the missing audit', async () => {
    const { credentialStore, service } = makeService();
    // Simulate: file written for generation 5, but the DB never committed.
    await credentialStore.writeCredential(FAKE_SERVICE_ACCOUNT, 5);
    expect(readGoogleSettings(db).credentialGeneration).toBe(0);

    await service.reconcileAtStartup();

    expect(readGoogleSettings(db).credentialGeneration).toBe(5);
    const audits = auditRows();
    expect(audits).toHaveLength(1);
    const details = JSON.parse(audits[0]!['details_json'] as string) as Record<string, unknown>;
    expect(details['action']).toBe('CREDENTIAL_CONNECTED');
    expect(details['reconciledAtStartup']).toBe(true);
    // now derived-connected
    const config = await service.getConfig();
    expect(config.connected).toBe(true);
  });

  it('committed disconnect with a lingering file (gen matches, active=false) → deleted, no new audit', async () => {
    const keyFile = join(dir, 'key.json');
    writeFileSync(keyFile, fakeServiceAccountJson());
    const { service, credentialStore } = makeService(true, keyFile);
    await service.connect(); // gen 1, active true
    // Simulate: disconnect committed (active=false) but the file cleanup failed.
    db.prepare("UPDATE settings SET value='false' WHERE key='google_credential_active'").run();
    expect(credentialStore.fileExists()).toBe(true);
    const auditsBefore = auditRows().length;

    await service.reconcileAtStartup();

    expect(credentialStore.fileExists()).toBe(false);
    expect(auditRows()).toHaveLength(auditsBefore);
  });

  it('stale file behind SQLite generation → committed generation wins, file deleted, connected=false', async () => {
    const keyFile = join(dir, 'key.json');
    writeFileSync(keyFile, fakeServiceAccountJson());
    const { service, credentialStore } = makeService(true, keyFile);
    await service.connect(); // gen 1
    await service.connect(); // gen 2
    // Simulate an interrupted rotation leaving an older file behind.
    await credentialStore.writeCredential(FAKE_SERVICE_ACCOUNT, 1);
    await service.reconcileAtStartup();
    expect(credentialStore.fileExists()).toBe(false);
    expect((await service.getConfig()).connected).toBe(false);
  });
});

describe('generation mismatch → not connected', () => {
  it('a file whose generation disagrees with SQLite is not usable', async () => {
    const { credentialStore, service } = makeService();
    await credentialStore.writeCredential(FAKE_SERVICE_ACCOUNT, 9);
    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('google_credential_generation','3',?)",
    ).run(now());
    const config = await service.getConfig();
    expect(config.connected).toBe(false);
    expect(await service.resolveExportContext()).toBeNull();
  });
});

describe('updateConfig', () => {
  it('rejects enable without a connected credential', async () => {
    const { service } = makeService();
    await expect(
      service.updateConfig({
        enabled: true,
        spreadsheetId: 'abcdefghij1234567890',
        salesSheetName: 'Sales',
        saleItemsSheetName: 'Sale Items',
      }),
    ).rejects.toMatchObject({ code: 'GOOGLE_NOT_CONNECTED' });
  });

  it('extracts a spreadsheet id from a pasted URL and persists + audits', async () => {
    const { service } = makeService();
    const config = await service.updateConfig({
      enabled: false,
      spreadsheetId: 'https://docs.google.com/spreadsheets/d/1AbC_dEfGhIjKlMnOpQr/edit#gid=0',
      salesSheetName: '  Sales  ',
      saleItemsSheetName: 'Sale Items',
    });
    expect(config.spreadsheetId).toBe('1AbC_dEfGhIjKlMnOpQr');
    expect(config.salesSheetName).toBe('Sales');
    expect(auditRows()).toHaveLength(1);
  });

  it('rejects a worksheet name with a forbidden character and an unknown field', async () => {
    const { service } = makeService();
    await expect(
      service.updateConfig({
        enabled: false,
        spreadsheetId: '',
        salesSheetName: 'Sales/2026',
        saleItemsSheetName: 'Sale Items',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(service.updateConfig({ enabled: false, extra: 1 } as never)).rejects.toMatchObject(
      {
        code: 'VALIDATION',
      },
    );
  });
});

describe('retryExport', () => {
  it('rejects a blank sale id', async () => {
    const { service } = makeService();
    try {
      await service.retryExport({ saleId: '  ' });
      throw new Error('expected rejection');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('VALIDATION');
    }
  });
});
