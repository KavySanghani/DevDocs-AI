import crypto from 'node:crypto';
import { query, withTransaction } from '@devdocs/db';
import type {
  OrganizationMemberResponse,
  OrganizationResponse,
  OrganizationRole,
} from '@devdocs/shared';

export class OrgError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string
  ) {
    super(message);
    this.name = 'OrgError';
  }
}

export interface MemberRecord {
  id: string;
  organization_id: string;
  user_id: string;
  role: OrganizationRole;
  created_at: Date;
  updated_at: Date;
}

export interface OrgWithRoleRow {
  id: string;
  name: string;
  slug: string;
  role: OrganizationRole;
  created_at: Date;
  joined_at?: Date;
}

/**
 * Generates a URL-safe lowercase slug from an organization name.
 */
export function generateSlug(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
  return base || 'org';
}

/**
 * Creates a new organization workspace and makes the creator an Admin.
 * Runs atomically inside a database transaction.
 */
export async function createOrganization(
  userId: string,
  name: string,
  customSlug?: string
): Promise<OrganizationResponse> {
  const baseSlug = customSlug?.trim() || generateSlug(name);

  return withTransaction(async (client) => {
    // Ensure slug uniqueness: if taken, append a 6-character random hex suffix
    let finalSlug = baseSlug;
    const existing = await client.query<{ id: string }>(
      'SELECT id FROM organizations WHERE slug = $1',
      [finalSlug]
    );
    if (existing.rows.length > 0) {
      const suffix = crypto.randomBytes(3).toString('hex');
      finalSlug = `${baseSlug}-${suffix}`;
    }

    const orgRes = await client.query<{ id: string; name: string; slug: string; created_at: Date }>(
      `INSERT INTO organizations (name, slug)
       VALUES ($1, $2)
       RETURNING id, name, slug, created_at`,
      [name.trim(), finalSlug]
    );

    const org = orgRes.rows[0];
    if (!org) {
      throw new OrgError('Failed to create organization', 500, 'INTERNAL_SERVER_ERROR');
    }

    // Automatically make the creator an Admin
    await client.query(
      `INSERT INTO organization_members (organization_id, user_id, role)
       VALUES ($1, $2, 'admin')`,
      [org.id, userId]
    );

    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      role: 'admin',
      createdAt: org.created_at.toISOString(),
    };
  });
}

/**
 * Retrieves all organizations that the specified user belongs to.
 */
export async function getUserOrganizations(userId: string): Promise<OrganizationResponse[]> {
  const res = await query<OrgWithRoleRow>(
    `SELECT o.id, o.name, o.slug, om.role, o.created_at, om.created_at as joined_at
     FROM organizations o
     JOIN organization_members om ON om.organization_id = o.id
     WHERE om.user_id = $1
     ORDER BY o.name ASC`,
    [userId]
  );

  return res.rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    role: row.role,
    createdAt: row.created_at.toISOString(),
  }));
}

/**
 * Retrieves a user's membership in a specific organization.
 * Returns null if the user is not a member.
 */
export async function getOrganizationMember(
  organizationId: string,
  userId: string
): Promise<{ id: string; organizationId: string; userId: string; role: OrganizationRole } | null> {
  const res = await query<MemberRecord>(
    `SELECT id, organization_id, user_id, role, created_at
     FROM organization_members
     WHERE organization_id = $1 AND user_id = $2`,
    [organizationId, userId]
  );

  const row = res.rows[0];
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    organizationId: row.organization_id,
    userId: row.user_id,
    role: row.role,
  };
}

/**
 * Retrieves organization details.
 * Strictly verifies membership to prevent resource existence disclosure.
 */
export async function getOrganizationDetails(
  organizationId: string,
  callerUserId: string
): Promise<OrganizationResponse> {
  const member = await getOrganizationMember(organizationId, callerUserId);
  if (!member) {
    throw new OrgError('Organization not found or access denied', 404, 'ORGANIZATION_NOT_FOUND');
  }

  const res = await query<{ id: string; name: string; slug: string; created_at: Date }>(
    'SELECT id, name, slug, created_at FROM organizations WHERE id = $1',
    [organizationId]
  );

  const org = res.rows[0];
  if (!org) {
    throw new OrgError('Organization not found or access denied', 404, 'ORGANIZATION_NOT_FOUND');
  }

  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    role: member.role,
    createdAt: org.created_at.toISOString(),
  };
}

/**
 * Lists all members of an organization.
 * Caller must be an active member (viewer or higher).
 */
export async function listOrganizationMembers(
  organizationId: string,
  callerUserId: string
): Promise<OrganizationMemberResponse[]> {
  const caller = await getOrganizationMember(organizationId, callerUserId);
  if (!caller) {
    throw new OrgError('Organization not found or access denied', 404, 'ORGANIZATION_NOT_FOUND');
  }

  const res = await query<{
    id: string;
    user_id: string;
    email: string;
    role: OrganizationRole;
    created_at: Date;
  }>(
    `SELECT om.id, om.user_id, u.email, om.role, om.created_at
     FROM organization_members om
     JOIN users u ON u.id = om.user_id
     WHERE om.organization_id = $1
     ORDER BY om.created_at ASC`,
    [organizationId]
  );

  return res.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    email: row.email,
    role: row.role,
    joinedAt: row.created_at.toISOString(),
  }));
}

/**
 * Adds an existing registered user to an organization with a specified role.
 * Caller must have the Admin role.
 */
export async function addOrganizationMember(
  organizationId: string,
  callerUserId: string,
  targetEmail: string,
  role: OrganizationRole
): Promise<OrganizationMemberResponse> {
  const caller = await getOrganizationMember(organizationId, callerUserId);
  if (!caller) {
    throw new OrgError('Organization not found or access denied', 404, 'ORGANIZATION_NOT_FOUND');
  }
  if (caller.role !== 'admin') {
    throw new OrgError('Forbidden: Only admins can manage organization members', 403, 'FORBIDDEN');
  }

  const normalizedEmail = targetEmail.toLowerCase().trim();
  const userRes = await query<{ id: string; email: string }>(
    'SELECT id, email FROM users WHERE email = $1',
    [normalizedEmail]
  );
  const targetUser = userRes.rows[0];
  if (!targetUser) {
    throw new OrgError('User with this email is not registered', 404, 'USER_NOT_FOUND');
  }

  // Check if target user is already a member
  const existingMember = await getOrganizationMember(organizationId, targetUser.id);
  if (existingMember) {
    throw new OrgError('User is already a member of this organization', 409, 'MEMBER_ALREADY_EXISTS');
  }

  const insertRes = await query<{ id: string; user_id: string; role: OrganizationRole; created_at: Date }>(
    `INSERT INTO organization_members (organization_id, user_id, role)
     VALUES ($1, $2, $3)
     RETURNING id, user_id, role, created_at`,
    [organizationId, targetUser.id, role]
  );

  const newMember = insertRes.rows[0]!;
  return {
    id: newMember.id,
    userId: newMember.user_id,
    email: targetUser.email,
    role: newMember.role,
    joinedAt: newMember.created_at.toISOString(),
  };
}

/**
 * Updates a member's role within an organization.
 * Caller must have the Admin role.
 * Prevents demoting the sole administrator.
 */
export async function updateMemberRole(
  organizationId: string,
  callerUserId: string,
  targetUserId: string,
  newRole: OrganizationRole
): Promise<OrganizationMemberResponse> {
  const caller = await getOrganizationMember(organizationId, callerUserId);
  if (!caller) {
    throw new OrgError('Organization not found or access denied', 404, 'ORGANIZATION_NOT_FOUND');
  }
  if (caller.role !== 'admin') {
    throw new OrgError('Forbidden: Only admins can update member roles', 403, 'FORBIDDEN');
  }

  const targetMember = await getOrganizationMember(organizationId, targetUserId);
  if (!targetMember) {
    throw new OrgError('Member not found in organization', 404, 'MEMBER_NOT_FOUND');
  }

  // Safety check: Cannot demote the last remaining admin
  if (targetMember.role === 'admin' && newRole !== 'admin') {
    const adminCountRes = await query<{ count: string }>(
      "SELECT count(*) FROM organization_members WHERE organization_id = $1 AND role = 'admin'",
      [organizationId]
    );
    const adminCount = parseInt(adminCountRes.rows[0]?.count ?? '0', 10);
    if (adminCount <= 1) {
      throw new OrgError(
        'Cannot demote the sole administrator of the organization. Promote another member to admin first.',
        400,
        'CANNOT_DEMOTE_LAST_ADMIN'
      );
    }
  }

  const updateRes = await query<{ id: string; user_id: string; role: OrganizationRole; created_at: Date }>(
    `UPDATE organization_members
     SET role = $1, updated_at = now()
     WHERE organization_id = $2 AND user_id = $3
     RETURNING id, user_id, role, created_at`,
    [newRole, organizationId, targetUserId]
  );

  const updated = updateRes.rows[0]!;
  const userRes = await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [targetUserId]);

  return {
    id: updated.id,
    userId: updated.user_id,
    email: userRes.rows[0]?.email ?? '',
    role: updated.role,
    joinedAt: updated.created_at.toISOString(),
  };
}

/**
 * Removes a member from an organization.
 * Caller must be Admin OR the member removing themselves (leaving).
 * Prevents removing the sole administrator.
 */
export async function removeOrganizationMember(
  organizationId: string,
  callerUserId: string,
  targetUserId: string
): Promise<{ success: boolean; message: string }> {
  const caller = await getOrganizationMember(organizationId, callerUserId);
  if (!caller) {
    throw new OrgError('Organization not found or access denied', 404, 'ORGANIZATION_NOT_FOUND');
  }

  const isSelf = callerUserId === targetUserId;
  if (!isSelf && caller.role !== 'admin') {
    throw new OrgError('Forbidden: Only admins can remove other members', 403, 'FORBIDDEN');
  }

  const targetMember = await getOrganizationMember(organizationId, targetUserId);
  if (!targetMember) {
    throw new OrgError('Member not found in organization', 404, 'MEMBER_NOT_FOUND');
  }

  // Safety check: Cannot remove the last remaining admin
  if (targetMember.role === 'admin') {
    const adminCountRes = await query<{ count: string }>(
      "SELECT count(*) FROM organization_members WHERE organization_id = $1 AND role = 'admin'",
      [organizationId]
    );
    const adminCount = parseInt(adminCountRes.rows[0]?.count ?? '0', 10);
    if (adminCount <= 1) {
      throw new OrgError(
        'Cannot remove the sole administrator of the organization.',
        400,
        'CANNOT_REMOVE_LAST_ADMIN'
      );
    }
  }

  await query(
    'DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2',
    [organizationId, targetUserId]
  );

  return {
    success: true,
    message: isSelf ? 'Successfully left the organization' : 'Member removed from organization',
  };
}
