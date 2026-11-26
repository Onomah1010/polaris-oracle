import { Request } from 'express';
import { readCookie } from './email-auth.controller';

describe('readCookie', () => {
  const makeReq = (cookieHeader?: string): Request => ({
    headers: { cookie: cookieHeader } as any,
  } as any);

  it('returns undefined when no cookie header', () => {
    const req = makeReq();
    expect(readCookie(req, 'session')).toBeUndefined();
  });

  it('parses simple cookie', () => {
    const req = makeReq('foo=bar; baz=qux');
    expect(readCookie(req, 'baz')).toBe('qux');
  });

  it('trims whitespace around name and value', () => {
    const req = makeReq('  session =  abc123  ; other=val');
    expect(readCookie(req, 'session')).toBe('abc123');
  });

  it('handles multiple = in value (e.g., JWT)', () => {
    const token = 'header.payload=signature=';
    const req = makeReq(`polaris_session=${encodeURIComponent(token)}; other=1`);
    expect(readCookie(req, 'polaris_session')).toBe(token);
  });

  it('returns undefined for missing cookie name', () => {
    const req = makeReq('a=1; b=2');
    expect(readCookie(req, 'c')).toBeUndefined();
  });

  it('ignores malformed parts without =', () => {
    const req = makeReq('valid=ok; malformed; another=good');
    expect(readCookie(req, 'another')).toBe('good');
  });
});