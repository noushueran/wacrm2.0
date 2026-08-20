import { describe, expect, it } from 'vitest';
import { nextSelectionAfterArchive } from './lead-analysis-selection';

const rows = (...ids: string[]) => ids.map((conversationId) => ({ conversationId }));

describe('nextSelectionAfterArchive', () => {
  it('advances to the following row when the selected lead is archived', () => {
    expect(nextSelectionAfterArchive(rows('a', 'b', 'c'), 'b', 'b')).toBe('c');
  });

  it('falls back to the previous row when the last row is archived', () => {
    expect(nextSelectionAfterArchive(rows('a', 'b', 'c'), 'c', 'c')).toBe('b');
  });

  it('clears selection when the only row is archived', () => {
    expect(nextSelectionAfterArchive(rows('a'), 'a', 'a')).toBeNull();
  });

  it('leaves selection untouched when a different row is archived', () => {
    expect(nextSelectionAfterArchive(rows('a', 'b', 'c'), 'a', 'b')).toBe('b');
  });

  it('leaves selection untouched when nothing is selected', () => {
    expect(nextSelectionAfterArchive(rows('a', 'b'), 'a', null)).toBeNull();
  });

  it('clears selection when the archived row is not in the list', () => {
    expect(nextSelectionAfterArchive(rows('a', 'b'), 'z', 'z')).toBeNull();
  });
});

// Page-boundary behaviour, pinned deliberately rather than left to fall
// out of the array arithmetic. With server-side paging the caller passes
// ONE PAGE of rows, so "the next lead" can sit on a page that isn't
// loaded. These two cases are the contract at that edge.
describe("nextSelectionAfterArchive at a page boundary", () => {
  it("falls back to the row above when the archived lead is last on the page", () => {
    const rows = [{ conversationId: "c1" }, { conversationId: "c2" }];
    expect(nextSelectionAfterArchive(rows, "c2", "c2")).toBe("c1");
  });

  it("clears the selection when the archived lead was the only row on the page", () => {
    expect(nextSelectionAfterArchive([{ conversationId: "c1" }], "c1", "c1")).toBeNull();
  });
});
