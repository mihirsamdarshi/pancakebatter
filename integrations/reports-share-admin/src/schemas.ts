import { z } from "zod";

export const MAX_GUESTS = 25;
export const MAX_EMAIL_LENGTH = 254;
export const MAX_BODY_BYTES = 16 * 1024;

// One address: lower case, at most 254 characters, exactly one @ with
// something on both sides, no wildcard, no spaces.
export const EmailSchema = z
  .string()
  .max(MAX_EMAIL_LENGTH)
  .regex(/^[^@\s*]+@[^@\s*]+$/, "must be one plain address with exactly one @ and no wildcard")
  .refine((email) => email === email.toLowerCase(), "must be lower case");

// PUT /guests. An empty list parses on purpose: the service refuses it with
// its own answer ("last guest"), not as a malformed body.
export const GuestsBodySchema = z.strictObject({
  emails: z
    .array(EmailSchema)
    .max(MAX_GUESTS)
    .refine((emails) => new Set(emails).size === emails.length, "must not repeat an address"),
});

export const LastLoginQuerySchema = z.strictObject({ email: EmailSchema });

// Notification routes (stub for now, see handler.ts). The text and the link
// are fixed in the service; the app only names what to announce.
const PlainText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((text) => !/[\u0000-\u001f\u007f]/.test(text), "must be plain text on one line");

export const InviteBodySchema = z.strictObject({ email: EmailSchema });
export const PublishedBodySchema = z.strictObject({
  collection: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  titles: z.array(PlainText(120)).min(1).max(10),
});
