const { z } = require('zod');

const accountTypeSchema = z.enum(['asset', 'liability', 'equity', 'income', 'expense']);

const requiredPositiveIntFromQuerySchema = z
  .string({ message: 'userId query parameter is required.' })
  .trim()
  .min(1, 'userId query parameter is required.')
  .regex(/^\d+$/, 'userId must be a positive integer.')
  .transform((value) => Number(value))
  .refine((value) => Number.isInteger(value) && value > 0, {
    message: 'userId must be a positive integer.',
  });

const userIdQuerySchema = z.object({
  userId: requiredPositiveIntFromQuerySchema,
});

const accountIdQuerySchema = z.object({
  accountId: z
    .string({ message: 'accountId query parameter is required.' })
    .trim()
    .min(1, 'accountId query parameter is required.')
    .uuid('accountId must be a valid UUID.'),
});

function mapZodIssues(error) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

module.exports = {
  z,
  accountTypeSchema,
  userIdQuerySchema,
  accountIdQuerySchema,
  mapZodIssues,
};
