import { describe, expect, it } from 'vitest';
import { parseBuildIdentity } from '../../src/main/app/buildIdentity';

describe('compile-time build identity', () => {
  it('contains app version, source revision, schema version, and build timestamp', () => {
    const sourceRevision = 'cace83641e666bfaeb72647040eb589b206e1b85';
    const identity = parseBuildIdentity(
      JSON.stringify({
        version: '1.2.3',
        schemaVersion: 7,
        sourceRevision,
        buildTimestamp: '2026-09-12T12:00:00Z',
      }),
      '1.2.3',
      7,
    );
    expect(identity).toEqual({
      appVersion: '1.2.3',
      schemaVersion: 7,
      sourceRevision,
      buildTimestamp: '2026-09-12T12:00:00.000Z',
      buildIdentifier: '1.2.3+cace83641e66.schema7',
    });
  });

  it('discards unsafe or version/schema-mismatched provenance instead of fabricating it', () => {
    for (const embedded of [
      '{not-json',
      JSON.stringify({ version: '1.2.4', schemaVersion: 7, sourceRevision: 'a'.repeat(40) }),
      JSON.stringify({ version: '1.2.3', schemaVersion: 8, sourceRevision: 'a'.repeat(40) }),
      JSON.stringify({ version: '1.2.3', schemaVersion: 7, sourceRevision: 'C:\\private\\repo' }),
    ]) {
      expect(parseBuildIdentity(embedded, '1.2.3', 7)).toMatchObject({
        appVersion: '1.2.3',
        schemaVersion: 7,
        sourceRevision: null,
        buildIdentifier: null,
      });
    }
  });

  it('has no runtime Git or filesystem dependency', () => {
    expect(parseBuildIdentity.toString()).not.toMatch(/exec|spawn|\.git|readFile/);
  });
});
