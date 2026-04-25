import { computeTokenAutoAdd } from './tokenAutoAdd';

describe('computeTokenAutoAdd', () => {
  it('adds previously-unseen detected tokens to favorites', () => {
    const r = computeTokenAutoAdd({
      detectedTokenIds: ['t1', 't2', 't3'],
      favoriteTokens: ['t1'],
      seenTokens: ['t1'],
    });
    expect(r.toAddToFavorites).toEqual(['t2', 't3']);
    expect(r.nextSeenTokens).toEqual(['t1', 't2', 't3']);
  });

  it('does NOT re-add tokens the user has already seen and removed', () => {
    // User saw 't2' before, removed it from favorites. Detection sees
    // 't2' again — must NOT re-add (Phase 2 P2.4 invariant).
    const r = computeTokenAutoAdd({
      detectedTokenIds: ['t1', 't2'],
      favoriteTokens: ['t1'],
      seenTokens: ['t1', 't2'],
    });
    expect(r.toAddToFavorites).toEqual([]);
    expect(r.nextSeenTokens).toEqual(['t1', 't2']);
  });

  it('first-run with empty seenTokens auto-adds everything detected', () => {
    const r = computeTokenAutoAdd({
      detectedTokenIds: ['t1', 't2', 't3'],
      favoriteTokens: [],
      seenTokens: [],
    });
    expect(r.toAddToFavorites).toEqual(['t1', 't2', 't3']);
    expect(r.nextSeenTokens).toEqual(['t1', 't2', 't3']);
  });

  it('handles undefined seenTokens (legacy storage)', () => {
    const r = computeTokenAutoAdd({
      detectedTokenIds: ['t1'],
      favoriteTokens: [],
      seenTokens: undefined,
    });
    expect(r.toAddToFavorites).toEqual(['t1']);
    expect(r.nextSeenTokens).toEqual(['t1']);
  });

  it('does NOT duplicate-add a token already in favorites but not yet in seen', () => {
    // Edge case: user added 't1' to favorites manually before P2.4 shipped.
    // First post-P2.4 run sees 't1' as detected. seenTokens is empty
    // (legacy). t1 IS in favorites already → must mark as seen but
    // NOT add it again to favorites.
    const r = computeTokenAutoAdd({
      detectedTokenIds: ['t1'],
      favoriteTokens: ['t1'],
      seenTokens: [],
    });
    expect(r.toAddToFavorites).toEqual([]);
    expect(r.nextSeenTokens).toEqual(['t1']);
  });

  it('skips empty/falsy ids defensively', () => {
    const r = computeTokenAutoAdd({
      detectedTokenIds: ['', 't1', '' as unknown as string],
      favoriteTokens: [],
      seenTokens: [],
    });
    expect(r.toAddToFavorites).toEqual(['t1']);
    expect(r.nextSeenTokens).toEqual(['t1']);
  });

  it('returns unchanged result when detection is empty', () => {
    const r = computeTokenAutoAdd({
      detectedTokenIds: [],
      favoriteTokens: ['t1'],
      seenTokens: ['t1'],
    });
    expect(r.toAddToFavorites).toEqual([]);
    expect(r.nextSeenTokens).toEqual(['t1']);
  });
});
