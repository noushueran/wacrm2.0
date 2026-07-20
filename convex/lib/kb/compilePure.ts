import { chunkText } from "../ai/chunk";
import { renderOpsSentinel } from "./sentinel";
import type { OpsBlockInput } from "./types";

export type ChunkPlan = { chunkIndex: number; content: string };

/**
 * Entry body → header-prefixed chunks. The bracket header names the
 * service and entry so a retrieved excerpt self-identifies inside the
 * prompt ("[Georgia Holiday Packages — Visa requirements]").
 */
export function planEntryChunks(args: {
  serviceName: string | null;
  title: string;
  body: string;
}): ChunkPlan[] {
  const header = `[${args.serviceName ?? "Company"} — ${args.title}]`;
  return chunkText(args.body).map((content, i) => ({
    chunkIndex: i,
    content: `${header}\n${content}`,
  }));
}

/**
 * Ops block → ONE sentinel chunk. Checklists and criteria must reach
 * the engines whole; chunk-splitting a checklist is the exact failure
 * mode v2 exists to kill. (An empty-items block still renders its
 * heading — publish-time lint blocks that case for real accounts.)
 */
export function planOpsChunks(serviceName: string, block: OpsBlockInput): ChunkPlan[] {
  const content = renderOpsSentinel(serviceName, block).trim();
  return content ? [{ chunkIndex: 0, content }] : [];
}
