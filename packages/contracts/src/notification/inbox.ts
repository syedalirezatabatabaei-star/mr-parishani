import * as z from 'zod';

/**
 * The bell (owner 1405/08/10; migration 0110): an account's own system notifications, made
 * from the domain events about it, and the announcements meant for it. Texts are generic, with
 * a link to the page; never an amount, a national ID or an account number.
 */
export const INBOX_SOURCES = ['system', 'announcement'] as const;

export const inboxItemSchema = z.object({
  id: z.string().min(1),
  source: z.enum(INBOX_SOURCES),
  kind: z.string(),
  title: z.string(),
  body: z.string(),
  linkHref: z.string().nullable(),
  urgent: z.boolean(),
  createdAt: z.iso.datetime({ offset: true }),
  read: z.boolean(),
});
export type InboxItem = z.infer<typeof inboxItemSchema>;

export const inboxSchema = z.object({
  items: z.array(inboxItemSchema),
  unread: z.int().nonnegative(),
});
export type Inbox = z.infer<typeof inboxSchema>;

/** `POST /me/inbox/read`: these items read, or every one when `all`. */
export const inboxReadSchema = z.union([
  z.object({ all: z.literal(true) }),
  z.object({ ids: z.array(z.string().min(1).max(80)).min(1).max(100) }),
]);
