import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import {
  LoginRequestSchema,
  RegisterRequestSchema,
} from '@devdocs/shared';
import { getEnv } from '../config/env.js';
import { authenticate } from '../middleware/auth.js';
import {
  AuthError,
  getUserById,
  loginUser,
  registerUser,
  revokeToken,
} from '../services/authService.js';
import { getUserOrganizations } from '../services/organizationService.js';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const env = getEnv();

  // POST /register - Register a new account
  app.post(
    '/register',
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: '1 minute',
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = RegisterRequestSchema.safeParse(request.body);
      if (!parseResult.success) {
        const issues = parseResult.error.issues.map((i: z.ZodIssue) => ({
          field: i.path.join('.'),
          message: i.message,
        }));
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid registration input',
            statusCode: 400,
            requestId: request.id,
            details: issues,
          },
        });
      }

      try {
        const { email, password } = parseResult.data;
        const result = await registerUser(email, password, env.JWT_SECRET);
        return reply.status(201).send(result);
      } catch (err) {
        if (err instanceof AuthError) {
          return reply.status(err.statusCode).send({
            error: {
              code: err.code,
              message: err.message,
              statusCode: err.statusCode,
              requestId: request.id,
            },
          });
        }
        throw err;
      }
    }
  );

  // POST /login - Authenticate with email and password
  app.post(
    '/login',
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = LoginRequestSchema.safeParse(request.body);
      if (!parseResult.success) {
        const issues = parseResult.error.issues.map((i: z.ZodIssue) => ({
          field: i.path.join('.'),
          message: i.message,
        }));
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid login input',
            statusCode: 400,
            requestId: request.id,
            details: issues,
          },
        });
      }

      try {
        const { email, password } = parseResult.data;
        const result = await loginUser(email, password, env.JWT_SECRET);
        return reply.status(200).send(result);
      } catch (err) {
        if (err instanceof AuthError) {
          return reply.status(err.statusCode).send({
            error: {
              code: err.code,
              message: err.message,
              statusCode: err.statusCode,
              requestId: request.id,
            },
          });
        }
        throw err;
      }
    }
  );

  // POST /logout - Explicit token revocation
  app.post(
    '/logout',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        return reply.status(401).send({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication required for logout',
            statusCode: 401,
            requestId: request.id,
          },
        });
      }

      await revokeToken(request.user.jti, request.user.userId);

      return reply.status(200).send({
        success: true,
        message: 'Logged out successfully. Token has been revoked.',
      });
    }
  );

  // GET /me - Retrieve current authenticated user and their organizations
  app.get(
    '/me',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        return reply.status(401).send({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication required',
            statusCode: 401,
            requestId: request.id,
          },
        });
      }

      const user = await getUserById(request.user.userId);
      if (!user) {
        return reply.status(404).send({
          error: {
            code: 'USER_NOT_FOUND',
            message: 'User account not found',
            statusCode: 404,
            requestId: request.id,
          },
        });
      }

      const organizations = await getUserOrganizations(user.id);

      return reply.status(200).send({
        user,
        organizations,
      });
    }
  );
}
