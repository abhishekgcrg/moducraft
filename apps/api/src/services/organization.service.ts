import type { ScopedTransaction } from "../db/transaction.js";
import { NotFoundError } from "../errors/app-errors.js";

export interface OrganizationWithRole {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
  updatedAt: Date;
  role: "owner" | "admin" | "member" | "viewer";
}

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  created_at: Date;
  updated_at: Date;
  role: "owner" | "admin" | "member" | "viewer";
}

export class OrganizationService {
  /**
   * List only organizations in which the authenticated user has an active membership.
   * Leverages PostgreSQL forced RLS and an explicit membership join.
   */
  async listUserOrganizations(
    tx: ScopedTransaction,
    userId: string
  ): Promise<OrganizationWithRole[]> {
    const query = `
      SELECT
        o.id,
        o.name,
        o.slug,
        o.created_at,
        o.updated_at,
        om.role
      FROM organizations o
      INNER JOIN organization_memberships om ON om.organization_id = o.id
      WHERE om.user_id = $1
      ORDER BY o.name ASC;
    `;

    const result = await tx.query<OrgRow>(query, [userId]);

    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      role: row.role,
    }));
  }

  /**
   * Retrieve an organization by ID, verifying that the user is a member.
   * Returns 404 (NotFoundError) if the organization does not exist or user lacks membership,
   * avoiding tenant enumeration leaks.
   */
  async getOrganization(
    tx: ScopedTransaction,
    orgId: string,
    userId: string
  ): Promise<OrganizationWithRole> {
    const query = `
      SELECT
        o.id,
        o.name,
        o.slug,
        o.created_at,
        o.updated_at,
        om.role
      FROM organizations o
      INNER JOIN organization_memberships om ON om.organization_id = o.id
      WHERE o.id = $1 AND om.user_id = $2;
    `;

    const result = await tx.query<OrgRow>(query, [orgId, userId]);
    const row = result.rows[0];

    if (!row) {
      throw new NotFoundError("Organization");
    }

    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      role: row.role,
    };
  }
}
