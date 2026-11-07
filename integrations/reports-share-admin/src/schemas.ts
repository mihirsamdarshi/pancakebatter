import { z } from "zod";

export const MAX_GUESTS = 25;
export const MAX_EMAIL_LENGTH = 254;
export const MAX_BODY_BYTES = 16 * 1024;

// One address: lower case, at most 254 characters, plain ASCII only (letters,
// digits and . _ % + - before the @; letters, digits, dashes and dots after
// it, with at least one dot). That leaves out wildcards, spaces, quotes,
// comments, IP literals, look-alike letters and invisible characters. No dot
// at the start or end of the part before the @, and no "..".
export const EmailSchema = z
  .string()
  .max(MAX_EMAIL_LENGTH)
  .refine((email) => email === email.toLowerCase(), "must be lower case")
  .regex(
    /^[a-z0-9._%+-]+@([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    "must be a plain ASCII address with one @, a domain with a dot and no wildcard",
  )
  .refine(
    (email) => !email.startsWith(".") && !email.includes("..") && !/\.@/.test(email),
    "must not start or end the name with a dot or have two dots in a row",
  );

// PUT /guests. An empty list parses on purpose: the service refuses it with
// its own answer ("last guest"), not as a malformed body.
export const GuestsBodySchema = z.strictObject({
  emails: z
    .array(EmailSchema)
    .max(MAX_GUESTS)
    .refine((emails) => new Set(emails).size === emails.length, "must not repeat an address"),
});

// PATCH /guests: a change to the list. At least one address in total.
export const GuestsPatchSchema = z
  .strictObject({
    add: z.array(EmailSchema).max(MAX_GUESTS).optional(),
    remove: z.array(EmailSchema).max(MAX_GUESTS).optional(),
  })
  .refine(
    (body) => (body.add?.length ?? 0) + (body.remove?.length ?? 0) > 0,
    "must name at least one address in add or remove",
  );

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
