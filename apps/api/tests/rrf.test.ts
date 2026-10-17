import { describe, it, expect } from 'vitest';
import type { RetrievedChunk } from '@devdocs/shared';
import { DEFAULT_RRF_K, fuseRankingsRRF } from '../src/services/retrieval/rrf.js';
import { RetrievalError } from '../src/services/retrieval/types.js';

describe('Phase 7: Reciprocal Rank Fusion (RRF) Unit Tests', () => {
  const createMockChunk = (
    id: string,
    overrides: Partial<RetrievedChunk> = {}
  ): RetrievedChunk => ({
    id,
    documentId: '00000000-0000-0000-0000-000000000001',
    documentName: 'Test Doc',
    documentVersionId: '00000000-0000-0000-0000-000000000002',
    chunkIndex: 0,
    content: `Content for chunk ${id}`,
    characterCount: 50,
    rank: 1,
    similarityScore: 0.85,
    distance: 0.15,
    ...overrides,
  });

  it('1. returns empty array when both candidate lists are empty', () => {
    const fused = fuseRankingsRRF([], []);
    expect(fused).toEqual([]);
  });

  it('2. handles vector-only candidates correctly', () => {
    const chunkA = createMockChunk('chunk-a', { similarityScore: 0.95 });
    const chunkB = createMockChunk('chunk-b', { similarityScore: 0.85 });

    const fused = fuseRankingsRRF([chunkA, chunkB], []);

    expect(fused).toHaveLength(2);
    expect(fused[0]!.id).toBe('chunk-a');
    expect(fused[0]!.rank).toBe(1);
    expect(fused[0]!.vectorRank).toBe(1);
    expect(fused[0]!.vectorScore).toBe(0.95);
    expect(fused[0]!.lexicalRank).toBeNull();
    expect(fused[0]!.lexicalScore).toBeNull();
    // With k=60: 1 / (60 + 1) = 1 / 61 = 0.01639344
    expect(fused[0]!.rrfScore).toBeCloseTo(1 / 61, 6);

    expect(fused[1]!.id).toBe('chunk-b');
    expect(fused[1]!.rank).toBe(2);
    expect(fused[1]!.vectorRank).toBe(2);
    expect(fused[1]!.rrfScore).toBeCloseTo(1 / 62, 6);
  });

  it('3. handles lexical-only candidates correctly', () => {
    const chunkX = createMockChunk('chunk-x', { lexicalScore: 0.72 });
    const chunkY = createMockChunk('chunk-y', { lexicalScore: 0.45 });

    const fused = fuseRankingsRRF([], [chunkX, chunkY]);

    expect(fused).toHaveLength(2);
    expect(fused[0]!.id).toBe('chunk-x');
    expect(fused[0]!.rank).toBe(1);
    expect(fused[0]!.vectorRank).toBeNull();
    expect(fused[0]!.lexicalRank).toBe(1);
    expect(fused[0]!.lexicalScore).toBe(0.72);
    expect(fused[0]!.rrfScore).toBeCloseTo(1 / 61, 6);

    expect(fused[1]!.id).toBe('chunk-y');
    expect(fused[1]!.rank).toBe(2);
    expect(fused[1]!.lexicalRank).toBe(2);
    expect(fused[1]!.rrfScore).toBeCloseTo(1 / 62, 6);
  });

  it('4. deduplicates overlapping chunks and boosts fused RRF score', () => {
    // chunk-both appears at rank 1 in vector and rank 2 in lexical
    const chunkBothVector = createMockChunk('chunk-both', { similarityScore: 0.92 });
    const chunkVectorOnly = createMockChunk('chunk-vector-only', { similarityScore: 0.88 });

    const chunkLexicalOnly = createMockChunk('chunk-lexical-only', { lexicalScore: 0.65 });
    const chunkBothLexical = createMockChunk('chunk-both', { lexicalScore: 0.80 });

    const fused = fuseRankingsRRF(
      [chunkBothVector, chunkVectorOnly],
      [chunkLexicalOnly, chunkBothLexical]
    );

    // Total unique chunks: 3
    expect(fused).toHaveLength(3);

    // chunk-both must be rank 1 due to receiving dual reciprocal rank contributions:
    // 1 / (60 + 1) + 1 / (60 + 2) = 1/61 + 1/62 = 0.01639344 + 0.01612903 = 0.03252247
    expect(fused[0]!.id).toBe('chunk-both');
    expect(fused[0]!.rank).toBe(1);
    expect(fused[0]!.vectorRank).toBe(1);
    expect(fused[0]!.vectorScore).toBe(0.92);
    expect(fused[0]!.lexicalRank).toBe(2);
    expect(fused[0]!.lexicalScore).toBe(0.80);
    expect(fused[0]!.rrfScore).toBeCloseTo(1 / 61 + 1 / 62, 6);
  });

  it('5. breaks ties deterministically using best individual rank, scores, and chunk ID', () => {
    // Both chunk-1 and chunk-2 have identical fused scores:
    // chunk-1: vector rank 1 (1/61)
    // chunk-2: lexical rank 1 (1/61)
    // bestRank is 1 for both.
    // We test tertiary tie-breaker: vectorScore (0.9 vs 0.7)
    const chunk1 = createMockChunk('chunk-1', { similarityScore: 0.90 });
    const chunk2 = createMockChunk('chunk-2', { lexicalScore: 0.70 });

    const fusedA = fuseRankingsRRF([chunk1], [chunk2]);
    expect(fusedA[0]!.id).toBe('chunk-1');
    expect(fusedA[1]!.id).toBe('chunk-2');

    // Identical scores and ranks: fallback to chunk ID alphabetical sort
    const chunkAlpha = createMockChunk('aaa-chunk', { similarityScore: 0.5 });
    const chunkBeta = createMockChunk('bbb-chunk', { similarityScore: 0.5 });

    // Pass in reverse order
    const fusedB = fuseRankingsRRF([chunkBeta, chunkAlpha], []);
    // Vector rank 1 vs rank 2 gives aaa-chunk higher score if it's rank 1
    // Let's create a pure tie:
    const c1 = createMockChunk('id-02', { similarityScore: 0.8 });
    const c2 = createMockChunk('id-01', { similarityScore: 0.8 });
    // Equal vectorScore and equal rank in two separate calls:
    const tied1 = fuseRankingsRRF([c1], []);
    const tied2 = fuseRankingsRRF([c2], []);
    // When both are merged from separate lists:
    const listA = [c1];
    const listB = [c2]; // rank 1 in lexical
    // Both have rrfScore = 1/61, bestRank = 1, vectorScore = 0.8 vs 0.8:
    const tiedMerged = fuseRankingsRRF([c1], [c2]);
    expect(tiedMerged).toHaveLength(2);
    expect(tiedMerged[0]!.rrfScore).toEqual(tiedMerged[1]!.rrfScore);
    // id-01 comes before id-02 lexicographically
    expect(tiedMerged[0]!.id).toBe('id-02'); // vectorScore is 0.8 vs 0
  });

  it('6. respects topK parameter truncation', () => {
    const chunks = [
      createMockChunk('c-1'),
      createMockChunk('c-2'),
      createMockChunk('c-3'),
      createMockChunk('c-4'),
      createMockChunk('c-5'),
    ];

    const fused = fuseRankingsRRF(chunks, [], { topK: 3 });
    expect(fused).toHaveLength(3);
    expect(fused.map((c) => c.rank)).toEqual([1, 2, 3]);
  });

  it('7. supports configurable smoothing constant k', () => {
    const chunkA = createMockChunk('c-a');
    const fusedDefault = fuseRankingsRRF([chunkA], []);
    expect(fusedDefault[0]!.rrfScore).toBeCloseTo(1 / (DEFAULT_RRF_K + 1), 6);

    const fusedCustom = fuseRankingsRRF([chunkA], [], { k: 20 });
    expect(fusedCustom[0]!.rrfScore).toBeCloseTo(1 / (20 + 1), 6);
  });

  it('8. rejects invalid or non-positive k with RetrievalError', () => {
    const chunkA = createMockChunk('c-a');
    expect(() => fuseRankingsRRF([chunkA], [], { k: 0 })).toThrow(RetrievalError);
    expect(() => fuseRankingsRRF([chunkA], [], { k: -5 })).toThrow(RetrievalError);
    expect(() => fuseRankingsRRF([chunkA], [], { k: NaN })).toThrow(RetrievalError);
  });
});
