import { describe, expect, it } from 'vitest';
import {
  buildTenantHostname,
  classifyHost,
  getCurrentAppHost,
  parseTenantSlugFromHost,
} from './tenantHost';

const APP = 'routecare.lovelesslabs.net';

describe('classifyHost', () => {
  it('treats apex and www apex as apex', () => {
    expect(classifyHost('routecare.lovelesslabs.net', APP)).toEqual({ kind: 'apex', appHost: APP });
    expect(classifyHost('www.routecare.lovelesslabs.net', APP)).toEqual({ kind: 'apex', appHost: APP });
  });

  it('extracts production tenant slugs', () => {
    expect(classifyHost('acme.routecare.lovelesslabs.net', APP)).toEqual({
      kind: 'tenant',
      slug: 'acme',
      appHost: APP,
    });
  });

  it('rejects nested production subdomains as foreign', () => {
    expect(classifyHost('acme.beta.routecare.lovelesslabs.net', APP)).toEqual({ kind: 'foreign' });
  });

  it('recognizes Coolify preview apex', () => {
    expect(classifyHost('pr-3-routecare.lovelesslabs.net', APP)).toEqual({
      kind: 'preview-apex',
      appHost: 'pr-3-routecare.lovelesslabs.net',
      previewId: 'pr-3',
    });
  });

  it('extracts slug from preview tenant hostname via -- separator', () => {
    expect(classifyHost('acme--pr-3-routecare.lovelesslabs.net', APP)).toEqual({
      kind: 'preview-tenant',
      slug: 'acme',
      appHost: 'pr-3-routecare.lovelesslabs.net',
      previewId: 'pr-3',
    });
  });

  it('treats unrelated hosts as foreign', () => {
    expect(classifyHost('n8n.lovelesslabs.net', APP)).toEqual({ kind: 'foreign' });
    expect(classifyHost('example.com', APP)).toEqual({ kind: 'foreign' });
    expect(classifyHost('', APP)).toEqual({ kind: 'foreign' });
  });

  it('strips port and is case-insensitive', () => {
    expect(classifyHost('Acme.RouteCare.LovelessLabs.NET:8080', APP)).toEqual({
      kind: 'tenant',
      slug: 'acme',
      appHost: APP,
    });
  });
});

describe('parseTenantSlugFromHost', () => {
  it('returns null on apex/preview-apex/foreign hosts', () => {
    expect(parseTenantSlugFromHost('routecare.lovelesslabs.net')).toBeNull();
    expect(parseTenantSlugFromHost('pr-3-routecare.lovelesslabs.net')).toBeNull();
    expect(parseTenantSlugFromHost('n8n.lovelesslabs.net')).toBeNull();
  });

  it('returns the slug on production and preview tenant hosts', () => {
    expect(parseTenantSlugFromHost('acme.routecare.lovelesslabs.net')).toBe('acme');
    expect(parseTenantSlugFromHost('acme--pr-3-routecare.lovelesslabs.net')).toBe('acme');
  });
});

describe('buildTenantHostname', () => {
  it('builds production-style hostnames when called from production', () => {
    expect(buildTenantHostname('acme', 'routecare.lovelesslabs.net', APP)).toBe('acme.routecare.lovelesslabs.net');
    expect(buildTenantHostname('acme', 'beta.routecare.lovelesslabs.net', APP)).toBe('acme.routecare.lovelesslabs.net');
  });

  it('builds preview-style hostnames when called from a preview', () => {
    expect(buildTenantHostname('acme', 'pr-3-routecare.lovelesslabs.net', APP)).toBe(
      'acme--pr-3-routecare.lovelesslabs.net',
    );
    expect(buildTenantHostname('acme', 'beta--pr-3-routecare.lovelesslabs.net', APP)).toBe(
      'acme--pr-3-routecare.lovelesslabs.net',
    );
  });

  it('falls back to production form for foreign hosts', () => {
    expect(buildTenantHostname('acme', 'localhost', APP)).toBe('acme.routecare.lovelesslabs.net');
  });
});

describe('getCurrentAppHost', () => {
  it('returns the apex host for the current deployment level', () => {
    expect(getCurrentAppHost('routecare.lovelesslabs.net', APP)).toBe('routecare.lovelesslabs.net');
    expect(getCurrentAppHost('acme.routecare.lovelesslabs.net', APP)).toBe('routecare.lovelesslabs.net');
    expect(getCurrentAppHost('pr-3-routecare.lovelesslabs.net', APP)).toBe('pr-3-routecare.lovelesslabs.net');
    expect(getCurrentAppHost('acme--pr-3-routecare.lovelesslabs.net', APP)).toBe('pr-3-routecare.lovelesslabs.net');
  });
});
