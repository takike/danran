import { z } from 'zod';

const builtInIsoDateSchema = z.string().date();

/**
 * Checks if a string is a real calendar date YYYY-MM-DD (validating month, day, and leap years) using Zod's built-in date schema.
 */
export function isValidIsoDateString(val: string): boolean {
  return builtInIsoDateSchema.safeParse(val).success;
}

/**
 * RFC3339 with explicit offset (Z or [+-]HH:MM) regex.
 * Hours: 00-23, Minutes: 00-59.
 * Offset hours: 00-23, offset minutes: 00-59.
 */
export const RFC3339_WITH_OFFSET_REGEX =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i;

/**
 * Checks if a string is a valid RFC3339 datetime with explicit offset and valid calendar date.
 */
export function isValidRfc3339String(val: string): boolean {
  if (!RFC3339_WITH_OFFSET_REGEX.test(val)) return false;
  const datePart = val.substring(0, 10);
  if (!isValidIsoDateString(datePart)) return false;
  const ms = Date.parse(val);
  return !Number.isNaN(ms);
}

/**
 * Validates IANA time zone identifier using Intl.DateTimeFormat.
 */
export function isValidIanaTimeZone(zone: string): boolean {
  if (typeof zone !== 'string' || zone.trim() === '') return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export const ianaTimeZoneSchema = z.string().refine(isValidIanaTimeZone, {
  message: 'Invalid IANA time zone identifier',
});

export const rfc3339InstantSchema = z.string().refine(isValidRfc3339String, {
  message: 'Invalid RFC3339 datetime with required offset',
});

export const isoDateStringSchema = z.string().date();
export const dateOnlySchema = isoDateStringSchema;

/**
 * Regex for valid client-generated Google Event ID (base32hex lowercase 5-1024 chars).
 */
export const googleEventIdRegex = /^[a-v0-9]{5,1024}$/;

/**
 * Outgoing Event DateTime object (strict).
 * Exactly ONE of date (YYYY-MM-DD) or dateTime (RFC3339 with explicit offset).
 * Optional IANA timeZone.
 */
export const insertEventDateTimeSchema = z
  .object({
    date: isoDateStringSchema.optional(),
    dateTime: rfc3339InstantSchema.optional(),
    timeZone: ianaTimeZoneSchema.optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    const hasDate = Boolean(val.date);
    const hasDateTime = Boolean(val.dateTime);
    if ((hasDate && hasDateTime) || (!hasDate && !hasDateTime)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Event datetime must specify exactly one of date or dateTime',
      });
    }
  });

export type InsertEventDateTime = z.infer<typeof insertEventDateTimeSchema>;

/**
 * Response Event DateTime object (strips unknown nested fields).
 */
export const googleEventDateTimeResponseSchema = z
  .object({
    date: isoDateStringSchema.optional(),
    dateTime: rfc3339InstantSchema.optional(),
    timeZone: ianaTimeZoneSchema.optional(),
  })
  .superRefine((val, ctx) => {
    const hasDate = Boolean(val.date);
    const hasDateTime = Boolean(val.dateTime);
    if ((hasDate && hasDateTime) || (!hasDate && !hasDateTime)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Event datetime must specify exactly one of date or dateTime',
      });
    }
  });

export type GoogleEventDateTime = z.infer<typeof googleEventDateTimeResponseSchema>;

/**
 * Validates start and end order and type consistency.
 * End must be strictly after start (equal is invalid).
 */
export function validateStartEndOrder(
  start: { date?: string; dateTime?: string },
  end: { date?: string; dateTime?: string },
  ctx: z.RefinementCtx,
): void {
  const startHasDate = Boolean(start.date);
  const endHasDate = Boolean(end.date);
  const startHasDateTime = Boolean(start.dateTime);
  const endHasDateTime = Boolean(end.dateTime);

  if (startHasDate !== endHasDate || startHasDateTime !== endHasDateTime) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'start and end must use the same format (both date or both dateTime)',
    });
    return;
  }

  if (start.date && end.date) {
    if (start.date >= end.date) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['end', 'date'],
        message: 'end date must be strictly after start date',
      });
    }
  }

  if (start.dateTime && end.dateTime) {
    const startTime = Date.parse(start.dateTime);
    const endTime = Date.parse(end.dateTime);
    if (!Number.isNaN(startTime) && !Number.isNaN(endTime)) {
      if (startTime >= endTime) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['end', 'dateTime'],
          message: 'end dateTime must be strictly after start dateTime',
        });
      }
    }
  }
}

/**
 * Outgoing extendedProperties schema (strict).
 */
export const insertExtendedPropertiesSchema = z
  .object({
    private: z.record(z.string()).optional(),
    shared: z.record(z.string()).optional(),
  })
  .strict();

export type InsertExtendedProperties = z.infer<typeof insertExtendedPropertiesSchema>;

/**
 * Response extendedProperties schema (strips unknown fields).
 */
export const googleExtendedPropertiesResponseSchema = z.object({
  private: z.record(z.string()).optional(),
  shared: z.record(z.string()).optional(),
});

export type GoogleExtendedProperties = z.infer<typeof googleExtendedPropertiesResponseSchema>;

/**
 * Google Event response schema. Unknown fields are stripped to prevent data leakage.
 * Confirmed/tentative events must contain start and end with end > start.
 * Cancelled events (tombstones or recurrence exceptions) may omit start and end.
 */
export const googleEventResponseSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(['confirmed', 'tentative', 'cancelled']).optional(),
    summary: z.string().optional(),
    description: z.string().optional(),
    location: z.string().optional(),
    start: googleEventDateTimeResponseSchema.optional(),
    end: googleEventDateTimeResponseSchema.optional(),
    recurrence: z.array(z.string()).optional(),
    recurringEventId: z.string().optional(),
    originalStartTime: googleEventDateTimeResponseSchema.optional(),
    transparency: z.enum(['opaque', 'transparent']).optional(),
    extendedProperties: googleExtendedPropertiesResponseSchema.optional(),
    htmlLink: z.string().optional(),
    etag: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    const isCancelled = val.status === 'cancelled';
    if (!isCancelled) {
      if (!val.start) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['start'],
          message: 'Active event must contain start',
        });
      }
      if (!val.end) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['end'],
          message: 'Active event must contain end',
        });
      }
      if (val.start && val.end) {
        validateStartEndOrder(val.start, val.end, ctx);
      }
    }
  });

export type GoogleEvent = z.infer<typeof googleEventResponseSchema>;

/**
 * Insert Event input schema (strict).
 */
export const insertEventInputSchema = z
  .object({
    id: z.string().regex(googleEventIdRegex).optional(),
    summary: z.string().optional(),
    description: z.string().optional(),
    location: z.string().optional(),
    start: insertEventDateTimeSchema,
    end: insertEventDateTimeSchema,
    recurrence: z.array(z.string()).optional(),
    transparency: z.enum(['opaque', 'transparent']).optional(),
    status: z.enum(['confirmed', 'tentative', 'cancelled']).optional(),
    extendedProperties: insertExtendedPropertiesSchema.optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    validateStartEndOrder(val.start, val.end, ctx);
  });

export type InsertEventInput = z.infer<typeof insertEventInputSchema>;

/**
 * Patch Event input schema (strict).
 * No default values injected. Null allows clearing supported fields.
 */
export const patchEventInputSchema = z
  .object({
    summary: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
    start: insertEventDateTimeSchema.optional(),
    end: insertEventDateTimeSchema.optional(),
    recurrence: z.array(z.string()).nullable().optional(),
    transparency: z.enum(['opaque', 'transparent']).optional(),
    status: z.enum(['confirmed', 'tentative', 'cancelled']).optional(),
    extendedProperties: insertExtendedPropertiesSchema.optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.start && val.end) {
      validateStartEndOrder(val.start, val.end, ctx);
    }
  });

export type PatchEventInput = z.infer<typeof patchEventInputSchema>;

/**
 * Options for events.insert (strict).
 */
export const eventsInsertOptionsSchema = z
  .object({
    sendUpdates: z.enum(['all', 'externalOnly', 'none']).optional(),
  })
  .strict();

export type EventsInsertOptions = z.input<typeof eventsInsertOptionsSchema>;

/**
 * Options for events.patch (strict).
 */
export const eventsPatchOptionsSchema = z
  .object({
    sendUpdates: z.enum(['all', 'externalOnly', 'none']).optional(),
  })
  .strict();

export type EventsPatchOptions = z.input<typeof eventsPatchOptionsSchema>;

/**
 * Options for events.delete (strict).
 */
export const eventsDeleteOptionsSchema = z
  .object({
    sendUpdates: z.enum(['all', 'externalOnly', 'none']).optional(),
  })
  .strict();

export type EventsDeleteOptions = z.input<typeof eventsDeleteOptionsSchema>;

/**
 * Options for events.get (strict).
 */
export const eventsGetOptionsSchema = z
  .object({
    timeZone: ianaTimeZoneSchema.default('Asia/Tokyo'),
  })
  .strict();

export type EventsGetOptions = z.input<typeof eventsGetOptionsSchema>;

/**
 * Options for events.list (strict).
 */
export const eventsListOptionsSchema = z
  .object({
    timeMin: rfc3339InstantSchema.optional(),
    timeMax: rfc3339InstantSchema.optional(),
    singleEvents: z.boolean().optional(),
    orderBy: z.enum(['startTime', 'updated']).optional(),
    showDeleted: z.boolean().optional(),
    maxResults: z.number().int().min(1).max(2500).optional(),
    pageToken: z.string().optional(),
    timeZone: ianaTimeZoneSchema.default('Asia/Tokyo'),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.orderBy === 'startTime' && val.singleEvents !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['orderBy'],
        message: "orderBy='startTime' requires singleEvents=true",
      });
    }
    if (val.timeMin && val.timeMax) {
      const minDate = Date.parse(val.timeMin);
      const maxDate = Date.parse(val.timeMax);
      if (!Number.isNaN(minDate) && !Number.isNaN(maxDate) && minDate >= maxDate) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['timeMax'],
          message: 'timeMax must be strictly after timeMin',
        });
      }
    }
  });

export type EventsListOptions = z.input<typeof eventsListOptionsSchema>;

/**
 * Options for events.instances (strict).
 */
export const eventsInstancesOptionsSchema = z
  .object({
    timeMin: rfc3339InstantSchema.optional(),
    timeMax: rfc3339InstantSchema.optional(),
    showDeleted: z.boolean().optional(),
    maxResults: z.number().int().min(1).max(2500).optional(),
    pageToken: z.string().optional(),
    timeZone: ianaTimeZoneSchema.default('Asia/Tokyo'),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.timeMin && val.timeMax) {
      const minDate = Date.parse(val.timeMin);
      const maxDate = Date.parse(val.timeMax);
      if (!Number.isNaN(minDate) && !Number.isNaN(maxDate) && minDate >= maxDate) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['timeMax'],
          message: 'timeMax must be strictly after timeMin',
        });
      }
    }
  });

export type EventsInstancesOptions = z.input<typeof eventsInstancesOptionsSchema>;

/**
 * Events list / instances paginated response.
 */
export const googleEventsPageResponseSchema = z.object({
  items: z.array(googleEventResponseSchema),
  nextPageToken: z.string().optional(),
  nextSyncToken: z.string().optional(),
  timeZone: z.string().optional(),
  etag: z.string().optional(),
});

export type GoogleEventsPage = z.infer<typeof googleEventsPageResponseSchema>;

/**
 * Insert Calendar input schema (strict).
 */
export const insertCalendarInputSchema = z
  .object({
    summary: z.string().min(1),
    description: z.string().optional(),
    timeZone: ianaTimeZoneSchema.default('Asia/Tokyo'),
  })
  .strict();

export type InsertCalendarInput = z.input<typeof insertCalendarInputSchema>;

/**
 * Google Calendar response schema.
 */
export const googleCalendarResponseSchema = z.object({
  id: z.string().min(1),
  summary: z.string(),
  description: z.string().optional(),
  timeZone: z.string().optional(),
  etag: z.string().optional(),
});

export type GoogleCalendar = z.infer<typeof googleCalendarResponseSchema>;

/**
 * ACL Scope input schema (strict).
 */
export const aclScopeInputSchema = z
  .object({
    type: z.enum(['user', 'group', 'domain', 'default']),
    value: z.string().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.type === 'user' || val.type === 'group') {
      if (!val.value || val.value.trim() === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['value'],
          message: `Scope type '${val.type}' requires a valid email value`,
        });
      } else {
        const emailResult = z.string().email().safeParse(val.value);
        if (!emailResult.success) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['value'],
            message: `Scope type '${val.type}' requires a valid email address`,
          });
        }
      }
    } else if (val.type === 'domain') {
      if (!val.value || val.value.trim() === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['value'],
          message: "Scope type 'domain' requires a non-empty domain value",
        });
      }
    } else if (val.type === 'default') {
      if (val.value !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['value'],
          message: "Scope type 'default' must not contain value",
        });
      }
    }
  });

export type AclScopeInput = z.infer<typeof aclScopeInputSchema>;

/**
 * Insert ACL rule input schema (strict).
 */
export const insertAclRuleInputSchema = z
  .object({
    role: z.enum(['none', 'freeBusyReader', 'reader', 'writer', 'owner']),
    scope: aclScopeInputSchema,
  })
  .strict();

export type InsertAclRuleInput = z.infer<typeof insertAclRuleInputSchema>;

/**
 * Options for acl.insert (strict).
 */
export const aclInsertOptionsSchema = z
  .object({
    sendNotifications: z.boolean().optional(),
  })
  .strict();

export type AclInsertOptions = z.input<typeof aclInsertOptionsSchema>;

/**
 * Google ACL rule response schema (strips unknown fields).
 */
export const googleAclRuleResponseSchema = z.object({
  id: z.string().min(1),
  role: z.enum([
    'none',
    'freeBusyReader',
    'reader',
    'writer',
    'writerWithoutPrivateAccess',
    'owner',
  ]),
  scope: z.object({
    type: z.enum(['user', 'group', 'domain', 'default']),
    value: z.string().optional(),
  }),
  etag: z.string().optional(),
});

export type GoogleAclRule = z.infer<typeof googleAclRuleResponseSchema>;

/**
 * CalendarList list options schema (strict).
 */
export const calendarListListOptionsSchema = z
  .object({
    maxResults: z.number().int().min(1).max(250).optional(),
    pageToken: z.string().optional(),
    showDeleted: z.boolean().optional(),
    showHidden: z.boolean().optional(),
  })
  .strict();

export type CalendarListListOptions = z.input<typeof calendarListListOptionsSchema>;

/**
 * Google CalendarList entry schema.
 */
export const googleCalendarListEntrySchema = z.object({
  id: z.string().min(1),
  summary: z.string().optional(),
  timeZone: z.string().optional(),
  accessRole: z.string().optional(),
  primary: z.boolean().optional(),
  selected: z.boolean().optional(),
  hidden: z.boolean().optional(),
  deleted: z.boolean().optional(),
  etag: z.string().optional(),
});

export type GoogleCalendarListEntry = z.infer<typeof googleCalendarListEntrySchema>;

/**
 * Google CalendarList paginated response schema.
 */
export const googleCalendarListPageResponseSchema = z.object({
  items: z.array(googleCalendarListEntrySchema),
  nextPageToken: z.string().optional(),
  nextSyncToken: z.string().optional(),
  etag: z.string().optional(),
});

export type GoogleCalendarListPage = z.infer<typeof googleCalendarListPageResponseSchema>;

/**
 * FreeBusy item input schema (strict).
 */
export const freeBusyItemInputSchema = z
  .object({
    id: z.string().min(1),
  })
  .strict();

export type FreeBusyItemInput = z.infer<typeof freeBusyItemInputSchema>;

/**
 * FreeBusy query input schema (strict).
 */
export const freeBusyQueryInputSchema = z
  .object({
    timeMin: rfc3339InstantSchema,
    timeMax: rfc3339InstantSchema,
    timeZone: ianaTimeZoneSchema.default('Asia/Tokyo'),
    items: z.array(freeBusyItemInputSchema).min(1).max(50),
    calendarExpansionMax: z.number().int().min(1).max(50).optional(),
    groupExpansionMax: z.number().int().min(1).max(100).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    const minDate = Date.parse(val.timeMin);
    const maxDate = Date.parse(val.timeMax);
    if (!Number.isNaN(minDate) && !Number.isNaN(maxDate) && minDate >= maxDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['timeMax'],
        message: 'timeMax must be strictly after timeMin',
      });
    }
  });

export type FreeBusyQueryInput = z.input<typeof freeBusyQueryInputSchema>;

/**
 * FreeBusy calendar error item schema.
 */
export const freeBusyCalendarErrorSchema = z.object({
  domain: z.string(),
  reason: z.string(),
});

export type FreeBusyCalendarError = z.infer<typeof freeBusyCalendarErrorSchema>;

/**
 * FreeBusy busy interval schema.
 * Strictly limited to start and end only. Title, location, description, attendees are stripped.
 * End must be strictly after start.
 */
export const freeBusyBusyIntervalSchema = z
  .object({
    start: rfc3339InstantSchema,
    end: rfc3339InstantSchema,
  })
  .superRefine((val, ctx) => {
    const s = Date.parse(val.start);
    const e = Date.parse(val.end);
    if (!Number.isNaN(s) && !Number.isNaN(e) && s >= e) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['end'],
        message: 'busy interval end must be strictly after start',
      });
    }
  });

export type FreeBusyBusyInterval = z.infer<typeof freeBusyBusyIntervalSchema>;

/**
 * FreeBusy calendar result schema.
 * Must contain busy intervals or non-empty errors (never represents error as free time).
 * Note: busy: [] is valid success (user has 0 busy intervals).
 */
export const freeBusyCalendarResponseSchema = z
  .object({
    busy: z.array(freeBusyBusyIntervalSchema).optional(),
    errors: z.array(freeBusyCalendarErrorSchema).optional(),
  })
  .superRefine((val, ctx) => {
    const hasBusy = val.busy !== undefined;
    const hasErrors = val.errors !== undefined && val.errors.length > 0;
    if (!hasBusy && !hasErrors) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Calendar entry must contain busy intervals or non-empty errors',
      });
    }
  });

export type FreeBusyCalendarResponse = z.infer<typeof freeBusyCalendarResponseSchema>;

/**
 * FreeBusy query response schema.
 */
export const freeBusyQueryResponseSchema = z.object({
  timeMin: rfc3339InstantSchema,
  timeMax: rfc3339InstantSchema,
  calendars: z.record(freeBusyCalendarResponseSchema),
  groups: z
    .record(
      z.object({
        calendars: z.array(z.string()).optional(),
        errors: z.array(freeBusyCalendarErrorSchema).optional(),
      }),
    )
    .optional(),
});

export type FreeBusyQueryResponse = z.infer<typeof freeBusyQueryResponseSchema>;

/**
 * Upstream Google API raw error schema for boundary sanitization.
 */
export const googleApiErrorBodySchema = z.object({
  error: z.object({
    code: z.number().optional(),
    message: z.string().optional(),
    errors: z
      .array(
        z.object({
          domain: z.string().optional(),
          reason: z.string().optional(),
          message: z.string().optional(),
        }),
      )
      .optional(),
    status: z.string().optional(),
  }),
});

export type GoogleApiErrorBody = z.infer<typeof googleApiErrorBodySchema>;
