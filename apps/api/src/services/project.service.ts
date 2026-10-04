import type { ScopedTransaction } from "../db/transaction.js";
import {
  NotFoundError,
  ForbiddenError,
  ConflictError,
} from "../errors/app-errors.js";

export interface ProjectDto {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  description: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateProjectInput {
  organizationId: string;
  name: string;
  slug: string;
  description?: string | null;
}

export interface UpdateProjectInput {
  name?: string;
  slug?: string;
  description?: string | null;
}

export interface ListProjectsFilter {
  organizationId?: string;
  limit?: number;
  offset?: number;
}

interface ProjectRow {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  description: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

interface OrgRoleRow {
  role: "owner" | "admin" | "member" | "viewer";
}

export class ProjectService {
  /**
   * Helper to map a raw database row to a ProjectDto.
   */
  private mapRow(row: ProjectRow): ProjectDto {
    return {
      id: row.id,
      organizationId: row.organization_id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Create a new project within an organization.
   * Derives created_by strictly from verified internal identity.
   * Requires owner, admin, or member role.
   * Atomically records a project.created audit event.
   */
  async createProject(
    tx: ScopedTransaction,
    userId: string,
    input: CreateProjectInput
  ): Promise<ProjectDto> {
    // 1. Verify organization membership and role
    const roleResult = await tx.query<OrgRoleRow>(
      `SELECT role FROM organization_memberships WHERE organization_id = $1 AND user_id = $2;`,
      [input.organizationId, userId]
    );

    const membership = roleResult.rows[0];
    if (!membership) {
      // Do not leak organization existence if user is not a member
      throw new NotFoundError("Organization");
    }

    if (membership.role === "viewer") {
      throw new ForbiddenError("Viewers are not permitted to create projects.");
    }

    // 2. Check for duplicate slug in the same organization
    const existing = await tx.query<{ id: string }>(
      `SELECT id FROM projects WHERE organization_id = $1 AND slug = $2;`,
      [input.organizationId, input.slug]
    );
    if (existing.rows.length > 0) {
      throw new ConflictError(
        `A project with slug '${input.slug}' already exists in this organization.`
      );
    }

    // 3. Insert project
    let projectRow: ProjectRow;
    try {
      const insertResult = await tx.query<ProjectRow>(
        `INSERT INTO projects (organization_id, name, slug, description, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, organization_id, name, slug, description, created_by, created_at, updated_at;`,
        [
          input.organizationId,
          input.name,
          input.slug,
          input.description ?? null,
          userId,
        ]
      );
      projectRow = insertResult.rows[0];
    } catch (err: any) {
      if (err.code === "23505") {
        throw new ConflictError(
          `A project with slug '${input.slug}' already exists in this organization.`
        );
      }
      throw err;
    }

    // 4. Record audit event atomically in the same transaction
    await tx.query(
      `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
      [
        input.organizationId,
        "project.created",
        "project",
        projectRow.id,
        "success",
        JSON.stringify({
          name: projectRow.name,
          slug: projectRow.slug,
        }),
      ]
    );

    return this.mapRow(projectRow);
  }

  /**
   * List projects accessible to the authenticated user under forced RLS.
   * Supports optional organizationId filter and pagination.
   */
  async listProjects(
    tx: ScopedTransaction,
    _userId: string,
    filter: ListProjectsFilter = {}
  ): Promise<{ projects: ProjectDto[]; pagination: { total: number; limit: number; offset: number } }> {
    const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100);
    const offset = Math.max(filter.offset ?? 0, 0);

    const countResult = await tx.query<{ total: string }>(
      `SELECT count(*)::text AS total
       FROM projects
       WHERE ($1::uuid IS NULL OR organization_id = $1);`,
      [filter.organizationId ?? null]
    );
    const total = parseInt(countResult.rows[0]?.total ?? "0", 10);

    const listResult = await tx.query<ProjectRow>(
      `SELECT id, organization_id, name, slug, description, created_by, created_at, updated_at
       FROM projects
       WHERE ($1::uuid IS NULL OR organization_id = $1)
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3;`,
      [filter.organizationId ?? null, limit, offset]
    );

    return {
      projects: listResult.rows.map((row) => this.mapRow(row)),
      pagination: {
        total,
        limit,
        offset,
      },
    };
  }

  /**
   * Retrieve a project by ID under forced RLS.
   * Returns 404 if project is missing or belongs to a tenant the user cannot access.
   */
  async getProject(tx: ScopedTransaction, projectId: string): Promise<ProjectDto> {
    const result = await tx.query<ProjectRow>(
      `SELECT id, organization_id, name, slug, description, created_by, created_at, updated_at
       FROM projects
       WHERE id = $1;`,
      [projectId]
    );

    const row = result.rows[0];
    if (!row) {
      throw new NotFoundError("Project");
    }

    return this.mapRow(row);
  }

  /**
   * Update a project's editable fields (name, slug, description).
   * Disallows changing id, organization_id, or created_by.
   * Requires owner, admin, or member role.
   * Atomically records a project.updated audit event.
   */
  async updateProject(
    tx: ScopedTransaction,
    projectId: string,
    userId: string,
    input: UpdateProjectInput
  ): Promise<ProjectDto> {
    // 1. Fetch current project
    const current = await this.getProject(tx, projectId);

    // 2. Check user's role in the organization
    const roleResult = await tx.query<OrgRoleRow>(
      `SELECT role FROM organization_memberships WHERE organization_id = $1 AND user_id = $2;`,
      [current.organizationId, userId]
    );
    const membership = roleResult.rows[0];
    if (!membership || membership.role === "viewer") {
      throw new ForbiddenError("You do not have permission to update this project.");
    }

    // 3. If slug is being updated, verify uniqueness
    if (input.slug && input.slug !== current.slug) {
      const existing = await tx.query<{ id: string }>(
        `SELECT id FROM projects WHERE organization_id = $1 AND slug = $2 AND id <> $3;`,
        [current.organizationId, input.slug, projectId]
      );
      if (existing.rows.length > 0) {
        throw new ConflictError(
          `A project with slug '${input.slug}' already exists in this organization.`
        );
      }
    }

    const updatedName = input.name ?? current.name;
    const updatedSlug = input.slug ?? current.slug;
    const hasDescriptionUpdate = input.description !== undefined;
    const updatedDescription = hasDescriptionUpdate ? input.description : current.description;

    // 4. Perform update
    let updatedRow: ProjectRow;
    try {
      const updateResult = await tx.query<ProjectRow>(
        `UPDATE projects
         SET name = $2,
             slug = $3,
             description = $4
         WHERE id = $1
         RETURNING id, organization_id, name, slug, description, created_by, created_at, updated_at;`,
        [projectId, updatedName, updatedSlug, updatedDescription]
      );
      updatedRow = updateResult.rows[0];
    } catch (err: any) {
      if (err.code === "23505") {
        throw new ConflictError(
          `A project with slug '${input.slug}' already exists in this organization.`
        );
      }
      throw err;
    }

    // 5. Record audit event atomically in the same transaction
    await tx.query(
      `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
      [
        current.organizationId,
        "project.updated",
        "project",
        projectId,
        "success",
        JSON.stringify({
          updatedFields: Object.keys(input),
          previous: {
            name: current.name,
            slug: current.slug,
          },
        }),
      ]
    );

    return this.mapRow(updatedRow);
  }

  /**
   * Delete a project.
   * Enforces owner or admin role restriction (members and viewers cannot delete).
   * Atomically records a project.deleted audit event before deletion.
   */
  async deleteProject(
    tx: ScopedTransaction,
    projectId: string,
    userId: string
  ): Promise<{ success: boolean; message: string }> {
    // 1. Fetch current project
    const current = await this.getProject(tx, projectId);

    // 2. Check user's role in the organization: only owner and admin can delete
    const roleResult = await tx.query<OrgRoleRow>(
      `SELECT role FROM organization_memberships WHERE organization_id = $1 AND user_id = $2;`,
      [current.organizationId, userId]
    );
    const membership = roleResult.rows[0];
    if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
      throw new ForbiddenError(
        "Only organization owners and admins can delete projects."
      );
    }

    // 3. Record audit event atomically before deletion
    await tx.query(
      `SELECT public.moducraft_record_audit_event($1, $2, $3, $4, $5, $6::jsonb);`,
      [
        current.organizationId,
        "project.deleted",
        "project",
        projectId,
        "success",
        JSON.stringify({
          name: current.name,
          slug: current.slug,
        }),
      ]
    );

    // 4. Delete the project
    await tx.query(`DELETE FROM projects WHERE id = $1;`, [projectId]);

    return {
      success: true,
      message: "Project deleted successfully.",
    };
  }
}
