import { z } from "zod";
import { PLANBAN_STATUSES } from "./types";

export const statusSchema = z.enum(PLANBAN_STATUSES);

export const manifestSchema = z.object({
  version: z.literal(1),
  repoId: z.string().min(1),
  enabled: z.boolean(),
  storage: z
    .object({
      kind: z.literal("local"),
      root: z.string().min(1).optional(),
    })
    .optional(),
});

export const roadmapItemSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    status: statusSchema,
    priority: z.number().int().nullable().default(null),
    summary: z.string().nullable().default(null),
    nextAction: z.string().nullable().default(null),
    tags: z.array(z.string()).default([]),
    icon: z.string().nullable().default(null),
    blockedBy: z.string().nullable().default(null),
    specDoc: z.string().nullable().default(null),
    planDoc: z.string().nullable().default(null),
    completedAt: z.string().nullable().default(null),
    updatedAt: z.string().nullable().default(null),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const roadmapSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative().default(1),
  updatedAt: z.string().min(1),
  project: z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    status: z.string().min(1),
    description: z.string().default(""),
    tags: z.array(z.string()).default([]),
  }),
  columns: z
    .array(
      z.object({
        id: statusSchema,
        label: z.string().min(1),
      }),
    )
    .default([]),
  roadmapItems: z.array(roadmapItemSchema).default([]),
});
