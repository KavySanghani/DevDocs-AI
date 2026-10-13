import type { FastifyReply, FastifyRequest } from 'fastify';
import { type OrganizationRole, hasMinimumRole } from '@devdocs/shared';
import { getEnv } from '../config/env.js';
import { getUserById, isTokenRevoked, verifyToken } from '../services/authService.js';
import { getOrganizationMember } from '../services/organizationService.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      userId: string;
      email: string;
      jti: string;
    };
    orgMember?: {
      organizationId: string;
      role: OrganizationRole;
    };
  }
}

/**
 * Fastify preHandler hook to authenticate requests using Bearer JWT.
 * Validates token signature, expiration, and ensures token is not in the revocation denylist.
 */
export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    void reply.status(401).send({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Missing or malformed Authorization header. Expected Bearer token.',
        statusCode: 401,
        requestId: request.id,
      },
    });
    return;
  }

  const token = authHeader.substring(7).trim();
  if (!token) {
    void reply.status(401).send({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Token is missing from Authorization header.',
        statusCode: 401,
        requestId: request.id,
      },
    });
    return;
  }

  const env = getEnv();

  try {
    const payload = verifyToken(token, env.JWT_SECRET);

    // Check if token has been revoked
    const isRevoked = await isTokenRevoked(payload.jti);
    if (isRevoked) {
      void reply.status(401).send({
        error: {
          code: 'TOKEN_REVOKED',
          message: 'Token has been revoked. Please log in again.',
          statusCode: 401,
          requestId: request.id,
        },
      });
      return;
    }

    // Verify user account status
    const user = await getUserById(payload.userId);
    if (!user || user.accountStatus !== 'active') {
      void reply.status(401).send({
        error: {
          code: 'ACCOUNT_INACTIVE',
          message: 'User account is inactive or not found.',
          statusCode: 401,
          requestId: request.id,
        },
      });
      return;
    }

    request.user = payload;
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? (err as { code: string }).code : 'INVALID_TOKEN';
    const message = err instanceof Error ? err.message : 'Invalid token';
    void reply.status(401).send({
      error: {
        code,
        message,
        statusCode: 401,
        requestId: request.id,
      },
    });
  }
}

/**
 * PreHandler factory that enforces organization membership and minimum RBAC role.
 * Never trusts a client-supplied organization ID without verifying membership in the database.
 * Returns 404 if the user is not a member to avoid disclosing whether an organization exists.
 */
export function requireOrgRole(minimumRole: OrganizationRole = 'viewer') {
  return async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!request.user) {
      void reply.status(401).send({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required before accessing organization resources.',
          statusCode: 401,
          requestId: request.id,
        },
      });
      return;
    }

    // Extract organization ID from route params, header, query, or body
    const params = request.params as { orgId?: string } | undefined;
    const body = request.body as { organizationId?: string } | undefined;
    const query = request.query as { orgId?: string } | undefined;
    const headerOrgId = request.headers['x-organization-id'] as string | undefined;

    const organizationId =
      params?.orgId || headerOrgId || query?.orgId || body?.organizationId;

    if (!organizationId) {
      void reply.status(400).send({
        error: {
          code: 'MISSING_ORGANIZATION_ID',
          message: 'Organization ID must be provided in route params (:orgId), X-Organization-Id header, query, or body.',
          statusCode: 400,
          requestId: request.id,
        },
      });
      return;
    }

    // Validate that the authenticated user is an active member of this organization
    const member = await getOrganizationMember(organizationId, request.user.userId);
    if (!member) {
      // Return 404 to avoid disclosing whether the organization exists to unauthorized users
      void reply.status(404).send({
        error: {
          code: 'ORGANIZATION_NOT_FOUND',
          message: 'Organization not found or access denied.',
          statusCode: 404,
          requestId: request.id,
        },
      });
      return;
    }

    // Check role permission against minimum required role
    if (!hasMinimumRole(member.role, minimumRole)) {
      void reply.status(403).send({
        error: {
          code: 'FORBIDDEN',
          message: `Insufficient permissions. Operation requires role "${minimumRole}" or higher, but you have "${member.role}".`,
          statusCode: 403,
          requestId: request.id,
        },
      });
      return;
    }

    request.orgMember = {
      organizationId: member.organizationId,
      role: member.role,
    };
  };
}
