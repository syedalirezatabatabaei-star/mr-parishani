/**
 * Every table of the application, re-exported from the modules that own them
 * (`src/modules/<name>/<name>.schema.ts`). drizzle-kit reads this file to draft migrations,
 * and the conventions test checks every table listed here.
 */
export * from '../modules/identity/identity.schema';
export * from '../modules/access/access.schema';
export * from '../modules/config/config.schema';
export * from '../modules/catalog/catalog.schema';
export * from '../modules/booking/booking.schema';
export * from '../modules/lead/lead.schema';
export * from '../modules/proforma/proforma.schema';
export * from '../modules/credit/credit.schema';
export * from '../modules/contract/contract.schema';
export * from '../modules/instrument/instrument.schema';
