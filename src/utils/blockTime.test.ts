import { formatBlockTime } from './blockTime';

describe('formatBlockTime', () => {
  const now = () => Math.floor(Date.now() / 1000);

  it("returns 'Pending' for undefined", () => {
    expect(formatBlockTime(undefined)).toBe('Pending');
  });

  it("returns 'Just now' for near-future timestamp (clock skew)", () => {
    expect(formatBlockTime(now() + 5)).toBe('Just now');
  });

  it('formats seconds-scale deltas', () => {
    expect(formatBlockTime(now() - 30)).toMatch(/^(30|29|28)s ago$/);
  });

  it('formats minutes-scale deltas', () => {
    expect(formatBlockTime(now() - 5 * 60)).toMatch(/^(5|4)m ago$/);
  });

  it('formats hours-scale deltas', () => {
    expect(formatBlockTime(now() - 5 * 3600)).toBe('5h ago');
  });

  it('formats days-scale deltas', () => {
    expect(formatBlockTime(now() - 3 * 86400)).toBe('3d ago');
  });

  it('falls back to absolute date past one week', () => {
    const out = formatBlockTime(now() - 14 * 86400);
    // Date.prototype.toLocaleDateString output depends on locale —
    // assert it's NOT the relative format, that's enough to prove
    // the branch was taken.
    expect(out).not.toMatch(/ago$/);
    expect(out).not.toBe('Pending');
    expect(out).not.toBe('Just now');
  });
});
