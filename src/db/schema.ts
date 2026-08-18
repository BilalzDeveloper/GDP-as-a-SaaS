// Drizzle mirror of the SQL schema for typed queries. The SQL migrations in
// supabase/migrations/ are the source of truth (working agreement: SQL
// migrations checked into the repo); keep this file in sync with them.
import {
  bigint,
  char,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const orgRole = pgEnum('org_role', [
  'admin',
  'compiler',
  'reviewer',
  'viewer',
]);

export const organization = pgTable('organization', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  countryCode: char('country_code', { length: 3 }),
  fiscalYearStartMonth: smallint('fiscal_year_start_month')
    .notNull()
    .default(1),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const membership = pgTable(
  'membership',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    role: orgRole('role').notNull().default('viewer'),
    invitedBy: uuid('invited_by'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

export const auditLog = pgTable('audit_log', {
  id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
  orgId: uuid('org_id'),
  actorId: uuid('actor_id'),
  occurredAt: timestamp('occurred_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  tableName: text('table_name').notNull(),
  action: text('action').notNull(),
  rowPk: text('row_pk').notNull(),
  oldData: jsonb('old_data'),
  newData: jsonb('new_data'),
  reason: text('reason').notNull(),
});
