// Drizzle mirror of the SQL schema for typed queries. The SQL migrations in
// supabase/migrations/ are the source of truth (working agreement: SQL
// migrations checked into the repo); keep this file in sync with them.
import {
  bigint,
  boolean,
  char,
  date,
  integer,
  jsonb,
  numeric,
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

// --- Reference data (milestone 2) --------------------------------------------

export const classificationKind = pgEnum('classification_kind', [
  'activity',
  'product',
  'consumption_purpose',
  'government_function',
  'institutional_sector',
  'geography',
  'other',
]);

export const referenceProvenance = pgEnum('reference_provenance', [
  'official_file',
  'transcribed_pending_verification',
  'tenant_defined',
]);

export const currency = pgTable('currency', {
  code: char('code', { length: 3 }).primaryKey(),
  name: text('name').notNull(),
  minorUnits: smallint('minor_units').notNull().default(2),
});

export const country = pgTable('country', {
  iso3: char('iso3', { length: 3 }).primaryKey(),
  iso2: char('iso2', { length: 2 }).notNull().unique(),
  name: text('name').notNull(),
  currencyCode: char('currency_code', { length: 3 }),
});

export const unit = pgTable('unit', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  unitType: text('unit_type').notNull(),
  currencyCode: char('currency_code', { length: 3 }),
  multiplier: numeric('multiplier', { precision: 20, scale: 6 })
    .notNull()
    .default('1'),
});

export const transactionCode = pgTable('transaction_code', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  sna2008Ref: text('sna2008_ref').notNull(),
  refVerified: boolean('ref_verified').notNull().default(false),
  description: text('description'),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const classification = pgTable('classification', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  kind: classificationKind('kind').notNull(),
  /** null = system-wide standard; set = a tenant's own classification. */
  ownerOrgId: uuid('owner_org_id').references(() => organization.id, {
    onDelete: 'cascade',
  }),
  basedOnId: uuid('based_on_id'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const classificationVersion = pgTable('classification_version', {
  id: uuid('id').primaryKey().defaultRandom(),
  classificationId: uuid('classification_id')
    .notNull()
    .references(() => classification.id, { onDelete: 'cascade' }),
  versionLabel: text('version_label').notNull(),
  validFrom: date('valid_from'),
  isCurrent: boolean('is_current').notNull().default(false),
  provenance: referenceProvenance('provenance').notNull(),
  sourceUrl: text('source_url'),
  sourceFileSha256: char('source_file_sha256', { length: 64 }),
  sourceRetrievedAt: timestamp('source_retrieved_at', { withTimezone: true }),
  /** Deepest hierarchy level present; the UI must not imply more coverage. */
  seededToLevel: smallint('seeded_to_level').notNull().default(1),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const classificationItem = pgTable('classification_item', {
  id: uuid('id').primaryKey().defaultRandom(),
  versionId: uuid('version_id')
    .notNull()
    .references(() => classificationVersion.id, { onDelete: 'cascade' }),
  code: text('code').notNull(),
  name: text('name').notNull(),
  parentId: uuid('parent_id'),
  level: smallint('level').notNull().default(1),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const classificationMapping = pgTable('classification_mapping', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerOrgId: uuid('owner_org_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  fromVersionId: uuid('from_version_id')
    .notNull()
    .references(() => classificationVersion.id),
  toVersionId: uuid('to_version_id')
    .notNull()
    .references(() => classificationVersion.id),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const classificationMappingEntry = pgTable(
  'classification_mapping_entry',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mappingId: uuid('mapping_id')
      .notNull()
      .references(() => classificationMapping.id, { onDelete: 'cascade' }),
    fromItemId: uuid('from_item_id')
      .notNull()
      .references(() => classificationItem.id),
    toItemId: uuid('to_item_id')
      .notNull()
      .references(() => classificationItem.id),
    weight: numeric('weight', { precision: 9, scale: 6 }).notNull().default('1'),
  },
);
