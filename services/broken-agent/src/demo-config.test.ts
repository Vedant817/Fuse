import { describe, expect, it } from 'vitest';
import { parseOutageMode, parsePermitTimeoutMs } from './demo-config.js';

describe('parsePermitTimeoutMs', () => {
  it('returns undefined when unset, deferring to the SDK default', () => {
    expect(parsePermitTimeoutMs(undefined)).toBeUndefined();
  });

  it('returns undefined for an empty/whitespace value, deferring to the SDK default', () => {
    expect(parsePermitTimeoutMs('')).toBeUndefined();
    expect(parsePermitTimeoutMs('   ')).toBeUndefined();
  });

  it('uses a valid positive integer override', () => {
    expect(parsePermitTimeoutMs('500')).toBe(500);
  });

  it('falls back to undefined (the SDK default) for a non-numeric value', () => {
    expect(parsePermitTimeoutMs('garbage')).toBeUndefined();
  });

  it('falls back to undefined (the SDK default) for zero or negative values', () => {
    expect(parsePermitTimeoutMs('0')).toBeUndefined();
    expect(parsePermitTimeoutMs('-100')).toBeUndefined();
  });

  it('falls back to undefined (the SDK default) for a non-integer value', () => {
    expect(parsePermitTimeoutMs('300.5')).toBeUndefined();
  });

  it('falls back to undefined (the SDK default) for NaN/Infinity-producing input', () => {
    expect(parsePermitTimeoutMs('NaN')).toBeUndefined();
    expect(parsePermitTimeoutMs('Infinity')).toBeUndefined();
    expect(parsePermitTimeoutMs('-Infinity')).toBeUndefined();
  });
});

describe('parseOutageMode', () => {
  it('defaults to fail-closed when unset', () => {
    expect(parseOutageMode(undefined)).toBe('fail-closed');
  });

  it('defaults to fail-closed for an empty/whitespace value', () => {
    expect(parseOutageMode('')).toBe('fail-closed');
    expect(parseOutageMode('   ')).toBe('fail-closed');
  });

  it('accepts a valid "fail-open" override', () => {
    expect(parseOutageMode('fail-open')).toBe('fail-open');
  });

  it('accepts a valid "fail-closed" override', () => {
    expect(parseOutageMode('fail-closed')).toBe('fail-closed');
  });

  it('falls back to fail-closed (the safer default) for an invalid value', () => {
    expect(parseOutageMode('garbage')).toBe('fail-closed');
    expect(parseOutageMode('FAIL-OPEN')).toBe('fail-closed');
    expect(parseOutageMode('open')).toBe('fail-closed');
  });
});
