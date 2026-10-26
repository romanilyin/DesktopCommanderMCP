import { distance } from 'fastest-levenshtein';

/**
 * Pure fuzzy-search core, kept free of app imports on purpose: it runs inside
 * the worker thread spawned by runFuzzySearchInWorker (fuzzySearch.ts), and
 * anything imported here is loaded per worker.
 */

export interface FuzzyMatch {
    start: number;
    end: number;
    value: string;
    distance: number;
}

/** Run a full fuzzy search and return the match for the worker bridge. */
export function runFuzzySearch(text: string, query: string): { result: FuzzyMatch } {
    return { result: recursiveFuzzyIndexOf(text, query) };
}

/**
 * Recursively finds the closest match to a query string within text using fuzzy matching
 * @param text The text to search within
 * @param query The query string to find
 * @param start Start index in the text (default: 0)
 * @param end End index in the text (default: text.length)
 * @param parentDistance Best distance found so far (default: Infinity)
 * @returns Object with start and end indices, matched value, and Levenshtein distance
 */
export function recursiveFuzzyIndexOf(text: string, query: string, start: number = 0, end: number | null = null, parentDistance: number = Infinity): FuzzyMatch {
    if (end === null) end = text.length;

    // For small text segments, use iterative approach
    if (end - start <= 2 * query.length) {
        return iterativeReduction(text, query, start, end, parentDistance);
    }

    let midPoint = start + Math.floor((end - start) / 2);
    let leftEnd = Math.min(end, midPoint + query.length); // Include query length to cover overlaps
    let rightStart = Math.max(start, midPoint - query.length); // Include query length to cover overlaps

    // Calculate distance for current segments
    let leftDistance = distance(text.substring(start, leftEnd), query);
    let rightDistance = distance(text.substring(rightStart, end), query);
    let bestDistance = Math.min(leftDistance, parentDistance, rightDistance);

    // If parent distance is already the best, use iterative approach
    if (parentDistance === bestDistance) {
        return iterativeReduction(text, query, start, end, parentDistance);
    }

    // Recursively search the better half
    if (leftDistance < rightDistance) {
        return recursiveFuzzyIndexOf(text, query, start, leftEnd, bestDistance);
    } else {
        return recursiveFuzzyIndexOf(text, query, rightStart, end, bestDistance);
    }
}

/**
 * Iteratively refines the best match by reducing the search area
 * @param text The text to search within
 * @param query The query string to find
 * @param start Start index in the text
 * @param end End index in the text
 * @param parentDistance Best distance found so far
 * @returns Object with start and end indices, matched value, and Levenshtein distance
 */
function iterativeReduction(text: string, query: string, start: number, end: number, parentDistance: number): FuzzyMatch {
    // Seed with the measured distance of this slice. For recursive callers
    // this equals parentDistance (the parent measured exactly this slice), but
    // a top-level call on text <= 2x query length arrives with Infinity, which
    // made the first shrink unconditional and a position-0 match unreachable.
    let bestDistance = distance(text.substring(start, end), query);
    let bestStart = start;
    let bestEnd = end;

    // Improve start position
    let nextDistance = distance(text.substring(bestStart + 1, bestEnd), query);

    while (nextDistance < bestDistance) {
        bestDistance = nextDistance;
        bestStart++;
        const smallerString = text.substring(bestStart + 1, bestEnd);
        nextDistance = distance(smallerString, query);
    }

    // Improve end position
    nextDistance = distance(text.substring(bestStart, bestEnd - 1), query);

    while (nextDistance < bestDistance) {
        bestDistance = nextDistance;
        bestEnd--;
        const smallerString = text.substring(bestStart, bestEnd - 1);
        nextDistance = distance(smallerString, query);
    }

    return {
        start: bestStart,
        end: bestEnd,
        value: text.substring(bestStart, bestEnd),
        distance: bestDistance
    };
}

/**
 * Calculates the similarity ratio between two strings
 * @param a First string
 * @param b Second string
 * @returns Similarity ratio (0-1)
 */
export function getSimilarityRatio(a: string, b: string): number {
    const maxLength = Math.max(a.length, b.length);
    if (maxLength === 0) return 1; // Both strings are empty

    const levenshteinDistance = distance(a, b);
    return 1 - (levenshteinDistance / maxLength);
}
