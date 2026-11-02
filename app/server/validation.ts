import { z } from 'zod';

const id = z.string().uuid();
const line = (max: number): z.ZodString => z.string().trim().min(1).max(max).regex(/^[^\p{Cc}]+$/u);
const text = (max: number): z.ZodString => z.string().trim().min(1).max(max).regex(/^(?:[^\p{Cc}]|[\t\n\r])*$/u);

export const streamerSchema = z.object({
  handle: z.string().regex(/^[a-z0-9_]{3,30}$/u),
  name: line(40),
  about: z.string().trim().max(2000).default(''),
}).strict();

export const entryActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    kind: z.enum(['topic', 'choice', 'binary']),
    title: line(160),
    body: text(2000).optional(),
    category: z.enum(['Tech & setups', 'Gaming', 'Creative', 'Just chatting']).optional(),
    options: z.array(line(80)).min(2).max(6).optional(),
    duration: z.union([z.literal(0), z.number().int().min(15).max(3600)]).default(0),
  }).strict(),
  z.object({ action: z.literal('vote'), id, choice: z.number().int().min(0).max(5) }).strict(),
  z.object({ action: z.literal('react'), id, value: z.union([z.literal(-1), z.literal(0), z.literal(1)]) }).strict(),
  z.object({ action: z.literal('reveal'), id }).strict(),
  z.object({ action: z.literal('delete'), id }).strict(),
  z.object({ action: z.literal('comment'), id, text: text(2000), parentId: id.nullable().optional() }).strict(),
]).superRefine((value, context) => {
  if (value.action !== 'create') return;
  if (value.kind === 'topic' && (!value.body || !value.category || value.title.length > 100)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Topics need a title up to 100 characters, details, and a category.' });
  }
  if (value.kind === 'choice' && (!value.options || new Set(value.options.map((option: string) => option.toLowerCase())).size !== value.options.length)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Add 2 to 6 different poll options.' });
  }
});

export const commentActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('like'), id, liked: z.boolean() }).strict(),
  z.object({ action: z.literal('delete'), id }).strict(),
]);

export const entryQuerySchema = z.object({
  kind: z.enum(['topics', 'polls']).default('topics'),
  sort: z.enum(['newest', 'top']).default('newest'),
  query: z.string().trim().max(100).default(''),
  cursor: z.string().max(1024).nullable().default(null),
}).strict();

export const commentQuerySchema = z.object({
  sort: z.enum(['newest', 'top']).default('newest'),
  cursor: z.string().max(1024).nullable().default(null),
}).strict();

export type StreamerInput = z.infer<typeof streamerSchema>;
export type EntryAction = z.infer<typeof entryActionSchema>;
export type CommentAction = z.infer<typeof commentActionSchema>;
export type EntryQuery = z.infer<typeof entryQuerySchema>;
export type CommentQuery = z.infer<typeof commentQuerySchema>;
