import { z } from 'zod';

/**
 * Standard Environment enumeration.
 */
export const EnvironmentSchema = z.enum(['development', 'test', 'production']);
export type Environment = z.infer<typeof EnvironmentSchema>;

/**
 * Schema for system health response (liveness and readiness).
 * Reports application state without leaking internal infrastructure details.
 */
export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded', 'unhealthy']),
  timestamp: z.string(),
  uptime: z.number(),
  version: z.string(),
  environment: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/**
 * Standard API error detail payload.
 */
export const ApiErrorDetailSchema = z.object({
  code: z.string(),
  message: z.string(),
  statusCode: z.number(),
  requestId: z.string().optional(),
  details: z.unknown().optional(),
});
export type ApiErrorDetail = z.infer<typeof ApiErrorDetailSchema>;

/**
 * Top-level structured error envelope.
 */
export const ApiErrorResponseSchema = z.object({
  error: ApiErrorDetailSchema,
});
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

// ==============================================================================
// Authentication & User Schemas (Phase 3)
// ==============================================================================

export const UserAccountStatusSchema = z.enum(['active', 'suspended', 'deactivated']);
export type UserAccountStatus = z.infer<typeof UserAccountStatusSchema>;

export const UserResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  accountStatus: UserAccountStatusSchema,
  createdAt: z.string(),
});
export type UserResponse = z.infer<typeof UserResponseSchema>;

export const RegisterRequestSchema = z.object({
  email: z
    .string()
    .email('Invalid email address')
    .transform((e) => e.toLowerCase().trim()),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must not exceed 128 characters'),
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const LoginRequestSchema = z.object({
  email: z
    .string()
    .email('Invalid email address')
    .transform((e) => e.toLowerCase().trim()),
  password: z.string().min(1, 'Password is required'),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const AuthResponseSchema = z.object({
  user: UserResponseSchema,
  token: z.string(),
  expiresIn: z.number(),
});
export type AuthResponse = z.infer<typeof AuthResponseSchema>;

export interface JwtTokenPayload {
  userId: string;
  email: string;
  jti: string;
}

// ==============================================================================
// Organization & RBAC Schemas (Phase 3)
// ==============================================================================

export const OrganizationRoleSchema = z.enum(['admin', 'member', 'viewer']);
export type OrganizationRole = z.infer<typeof OrganizationRoleSchema>;

export const ROLE_HIERARCHY: Record<OrganizationRole, number> = {
  admin: 3,
  member: 2,
  viewer: 1,
};

/**
 * Checks whether userRole satisfies or exceeds requiredRole.
 */
export function hasMinimumRole(
  userRole: OrganizationRole,
  requiredRole: OrganizationRole
): boolean {
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[requiredRole];
}

export const OrganizationResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  role: OrganizationRoleSchema.optional(),
  createdAt: z.string(),
});
export type OrganizationResponse = z.infer<typeof OrganizationResponseSchema>;

export const OrganizationMemberResponseSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  email: z.string(),
  role: OrganizationRoleSchema,
  joinedAt: z.string(),
});
export type OrganizationMemberResponse = z.infer<typeof OrganizationMemberResponseSchema>;

export const CreateOrganizationRequestSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(100),
  slug: z
    .string()
    .min(2, 'Slug must be at least 2 characters')
    .max(100)
    .regex(/^[a-z0-9-]+$/, 'Slug must consist only of lowercase alphanumeric characters and hyphens')
    .optional(),
});
export type CreateOrganizationRequest = z.infer<typeof CreateOrganizationRequestSchema>;

export const AddMemberRequestSchema = z.object({
  email: z
    .string()
    .email('Invalid email address')
    .transform((e) => e.toLowerCase().trim()),
  role: OrganizationRoleSchema,
});
export type AddMemberRequest = z.infer<typeof AddMemberRequestSchema>;

export const UpdateMemberRoleRequestSchema = z.object({
  role: OrganizationRoleSchema,
});
export type UpdateMemberRoleRequest = z.infer<typeof UpdateMemberRoleRequestSchema>;
