import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const polls = sqliteTable('polls', {
  id: text('id').primaryKey(), question: text('question').notNull(),
  kind: text('kind').notNull(), options: text('options').notNull(),
  createdAt: integer('created_at').notNull(), endsAt: integer('ends_at').notNull(),
  revealed: integer('revealed').notNull().default(0),
});
export const votes = sqliteTable('poll_votes', {
  pollId: text('poll_id').notNull().references(() => polls.id),
  userId: text('user_id').notNull(), choice: integer('choice').notNull(),
}, (table) => [primaryKey({ columns: [table.pollId, table.userId] })]);
export const reactions = sqliteTable('poll_reactions', {
  pollId: text('poll_id').notNull().references(() => polls.id),
  userId: text('user_id').notNull(), value: integer('value').notNull(),
}, (table) => [primaryKey({ columns: [table.pollId, table.userId] })]);
export const comments = sqliteTable('poll_comments', {
  id: text('id').primaryKey(), pollId: text('poll_id').notNull().references(() => polls.id),
  userId: text('user_id').notNull(), text: text('text').notNull(), createdAt: integer('created_at').notNull(),
}, (table) => [
  index('poll_comments_history_idx').on(table.pollId, table.createdAt, table.id),
  index('poll_comments_rate_idx').on(table.pollId, table.userId, table.createdAt),
]);
