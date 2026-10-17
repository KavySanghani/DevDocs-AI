import type { RetrievedChunk } from '@devdocs/shared';
import { RetrievalError } from './types.js';

/**
 * Standard Reciprocal Rank Fusion (RRF) smoothing constant.
 * Widely established in information retrieval literature (Cormack et al., SIGIR 2009)
 * and industry search engines (Lucene, Elasticsearch, Azure AI Search).
 */
export const DEFAULT_RRF_K = 60;

export interface RRFOptions {
  k?: number | undefined;
  topK?: number | undefined;
}

interface CandidateAccumulator {
  chunk: RetrievedChunk;
  vectorRank: number | null;
  vectorScore: number | null;
  lexicalRank: number | null;
  lexicalScore: number | null;
  rrfScore: number;
}

/**
 * Deterministic Reciprocal Rank Fusion (RRF) algorithm.
 *
 * Formula:
 *   RRF(c) = SUM_m [ 1 / (k + rank_m(c)) ]
 * where:
 *   - m in {vector, lexical}
 *   - rank_m(c) is the 1-based rank of chunk c in retriever m
 *   - k is the ranking smoothing constant (default: 60)
 *
 * Guarantees:
 * 1. Strict deduplication by chunk ID across candidate pools.
 * 2. Unambiguous diagnostic preservation: vectorRank, vectorScore, lexicalRank, lexicalScore, and rrfScore.
 * 3. 100% deterministic tie-breaking for equal fused scores:
 *    - Best individual rank (min of vectorRank and lexicalRank)
 *    - Higher vector similarity score
 *    - Higher lexical score
 *    - Lexicographical chunk ID comparison
 */
export function fuseRankingsRRF(
  vectorCandidates: RetrievedChunk[] = [],
  lexicalCandidates: RetrievedChunk[] = [],
  options: RRFOptions = {}
): RetrievedChunk[] {
  const k = options.k ?? DEFAULT_RRF_K;
  if (!Number.isFinite(k) || k <= 0) {
    throw new RetrievalError('RRF ranking constant (k) must be a positive number', 'INVALID_PARAM', 400);
  }

  const map = new Map<string, CandidateAccumulator>();

  // 1. Process semantic vector candidates
  for (let idx = 0; idx < vectorCandidates.length; idx++) {
    const chunk = vectorCandidates[idx]!;
    const rank = idx + 1;
    const score = chunk.similarityScore ?? chunk.vectorScore ?? null;

    map.set(chunk.id, {
      chunk,
      vectorRank: rank,
      vectorScore: score,
      lexicalRank: null,
      lexicalScore: null,
      rrfScore: 0,
    });
  }

  // 2. Process lexical candidates and merge overlapping chunks
  for (let idx = 0; idx < lexicalCandidates.length; idx++) {
    const chunk = lexicalCandidates[idx]!;
    const rank = idx + 1;
    const score = chunk.lexicalScore ?? chunk.score ?? null;

    const existing = map.get(chunk.id);
    if (existing) {
      existing.lexicalRank = rank;
      existing.lexicalScore = score;
    } else {
      map.set(chunk.id, {
        chunk,
        vectorRank: null,
        vectorScore: null,
        lexicalRank: rank,
        lexicalScore: score,
        rrfScore: 0,
      });
    }
  }

  // 3. Compute deterministic RRF scores
  const candidates: CandidateAccumulator[] = [];

  for (const entry of map.values()) {
    let rrf = 0;
    if (entry.vectorRank !== null) {
      rrf += 1 / (k + entry.vectorRank);
    }
    if (entry.lexicalRank !== null) {
      rrf += 1 / (k + entry.lexicalRank);
    }

    entry.rrfScore = Number(rrf.toFixed(8));
    candidates.push(entry);
  }

  // 4. Deterministic sorting with multi-tier tie-breakers
  candidates.sort((a, b) => {
    // Primary: Fused RRF score (descending)
    if (b.rrfScore !== a.rrfScore) {
      return b.rrfScore - a.rrfScore;
    }

    // Secondary: Best individual rank in any system (ascending)
    const bestRankA = Math.min(a.vectorRank ?? Infinity, a.lexicalRank ?? Infinity);
    const bestRankB = Math.min(b.vectorRank ?? Infinity, b.lexicalRank ?? Infinity);
    if (bestRankA !== bestRankB) {
      return bestRankA - bestRankB;
    }

    // Tertiary: Higher vector similarity score (descending)
    const vScoreA = a.vectorScore ?? 0;
    const vScoreB = b.vectorScore ?? 0;
    if (vScoreB !== vScoreA) {
      return vScoreB - vScoreA;
    }

    // Quaternary: Higher lexical score (descending)
    const lScoreA = a.lexicalScore ?? 0;
    const lScoreB = b.lexicalScore ?? 0;
    if (lScoreB !== lScoreA) {
      return lScoreB - lScoreA;
    }

    // Final deterministic fallback: Lexicographical chunk ID
    return a.chunk.id.localeCompare(b.chunk.id);
  });

  // 5. Slice to topK if requested
  const sliced = typeof options.topK === 'number' && options.topK > 0
    ? candidates.slice(0, options.topK)
    : candidates;

  // 6. Map to final RetrievedChunk array with updated ranks and diagnostics
  return sliced.map((entry, index) => {
    const finalRank = index + 1;
    return {
      ...entry.chunk,
      rank: finalRank,
      score: entry.rrfScore,
      rrfScore: entry.rrfScore,
      vectorRank: entry.vectorRank,
      vectorScore: entry.vectorScore,
      lexicalRank: entry.lexicalRank,
      lexicalScore: entry.lexicalScore,
      similarityScore: entry.chunk.similarityScore ?? (entry.vectorScore ?? undefined),
      distance: entry.chunk.distance,
    };
  });
}
