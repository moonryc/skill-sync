import { posix, win32 } from 'node:path';

import { z } from 'zod';

export const PROJECT_MANIFEST_SCHEMA_VERSION = 1 as const;
export const PROJECT_LOCK_SCHEMA_VERSION = 1 as const;
export const PROJECT_MANIFEST_FILENAME = 'skill-sync.json' as const;
export const PROJECT_LOCK_FILENAME = 'skill-sync.lock.json' as const;

const targetNameSchema = z.enum(['codex', 'claude']);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u, 'Expected a lowercase SHA-256 digest.');
const commitSchema = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u, 'Expected a full Git object ID.');

const portableSegmentPattern = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;

export function isPortableRelativePath(value: string): boolean {
  if (
    value === '' ||
    value.includes('\0') ||
    value.includes('\\') ||
    posix.isAbsolute(value) ||
    win32.isAbsolute(value)
  ) {
    return false;
  }

  const segments = value.split('/');
  return segments.every(
    (segment) =>
      segment !== '' && segment !== '.' && segment !== '..' && segment.trim() === segment,
  );
}

export const portableRelativePathSchema = z
  .string()
  .max(1_024)
  .refine(isPortableRelativePath, 'Expected a normalized portable relative path.');

export const qualifiedProjectSkillIdSchema = z
  .string()
  .max(512)
  .refine((value) => {
    if (!isPortableRelativePath(value)) return false;
    return value.split('/').every((segment) => portableSegmentPattern.test(segment));
  }, 'Expected a lowercase portable qualified skill ID.');

export const libraryIdentitySchema = z
  .string()
  .max(512)
  .refine((value) => {
    if (
      /(?:[:@?#\\]|\s|\/\/)/u.test(value) ||
      !isPortableRelativePath(value) ||
      value.split('/').length < 2
    ) {
      return false;
    }
    return value.split('/').every((segment) => /^[A-Za-z0-9._-]+$/u.test(segment));
  }, 'Expected a credential-free normalized library identity, not a repository URL.');

const desiredProjectionSchema = z.strictObject({
  destination: portableRelativePathSchema,
  target: targetNameSchema,
});

const desiredSkillSchema = z
  .strictObject({
    id: qualifiedProjectSkillIdSchema,
    projections: z.array(desiredProjectionSchema).min(1),
  })
  .superRefine((skill, context) => {
    const targets = new Set<string>();
    const destinations = new Set<string>();
    skill.projections.forEach((projection, index) => {
      if (targets.has(projection.target)) {
        context.addIssue({
          code: 'custom',
          message: `Target ${projection.target} occurs more than once.`,
          path: ['projections', index, 'target'],
        });
      }
      if (destinations.has(projection.destination)) {
        context.addIssue({
          code: 'custom',
          message: `Destination ${projection.destination} occurs more than once.`,
          path: ['projections', index, 'destination'],
        });
      }
      targets.add(projection.target);
      destinations.add(projection.destination);
    });
  });

export const projectManifestSchema = z
  .strictObject({
    gitignore: z.enum(['managed', 'unmanaged']),
    library: z.strictObject({ identity: libraryIdentitySchema }),
    schemaVersion: z.literal(PROJECT_MANIFEST_SCHEMA_VERSION),
    skills: z.array(desiredSkillSchema),
  })
  .superRefine((manifest, context) => {
    const ids = new Set<string>();
    manifest.skills.forEach((skill, index) => {
      if (ids.has(skill.id)) {
        context.addIssue({
          code: 'custom',
          message: `Skill ${skill.id} occurs more than once.`,
          path: ['skills', index, 'id'],
        });
      }
      ids.add(skill.id);
    });
  });

const resolvedProjectionSchema = desiredProjectionSchema.extend({ digest: digestSchema });

const resolvedSkillSchema = z
  .strictObject({
    baseDigest: digestSchema,
    canonicalDigest: digestSchema,
    id: qualifiedProjectSkillIdSchema,
    projections: z.array(resolvedProjectionSchema).min(1),
  })
  .superRefine((skill, context) => {
    const targets = new Set<string>();
    const destinations = new Set<string>();
    skill.projections.forEach((projection, index) => {
      if (targets.has(projection.target)) {
        context.addIssue({
          code: 'custom',
          message: `Target ${projection.target} occurs more than once.`,
          path: ['projections', index, 'target'],
        });
      }
      if (destinations.has(projection.destination)) {
        context.addIssue({
          code: 'custom',
          message: `Destination ${projection.destination} occurs more than once.`,
          path: ['projections', index, 'destination'],
        });
      }
      targets.add(projection.target);
      destinations.add(projection.destination);
    });
  });

export const projectLockSchema = z
  .strictObject({
    library: z.strictObject({
      identity: libraryIdentitySchema,
      revision: commitSchema,
    }),
    schemaVersion: z.literal(PROJECT_LOCK_SCHEMA_VERSION),
    skills: z.array(resolvedSkillSchema),
  })
  .superRefine((lock, context) => {
    const ids = new Set<string>();
    lock.skills.forEach((skill, index) => {
      if (ids.has(skill.id)) {
        context.addIssue({
          code: 'custom',
          message: `Skill ${skill.id} occurs more than once.`,
          path: ['skills', index, 'id'],
        });
      }
      ids.add(skill.id);
    });
  });

export type ProjectManifest = z.infer<typeof projectManifestSchema>;
export type ProjectLock = z.infer<typeof projectLockSchema>;
export type DesiredSkill = ProjectManifest['skills'][number];
export type ResolvedSkill = ProjectLock['skills'][number];

function compareProjection(
  left: { readonly target: string; readonly destination: string },
  right: { readonly target: string; readonly destination: string },
): number {
  return (
    left.target.localeCompare(right.target) || left.destination.localeCompare(right.destination)
  );
}

export function canonicalizeProjectManifest(manifest: ProjectManifest): ProjectManifest {
  return {
    gitignore: manifest.gitignore,
    library: { identity: manifest.library.identity },
    schemaVersion: PROJECT_MANIFEST_SCHEMA_VERSION,
    skills: manifest.skills
      .map((skill) => ({
        id: skill.id,
        projections: [...skill.projections].sort(compareProjection),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function canonicalizeProjectLock(lock: ProjectLock): ProjectLock {
  return {
    library: { identity: lock.library.identity, revision: lock.library.revision },
    schemaVersion: PROJECT_LOCK_SCHEMA_VERSION,
    skills: lock.skills
      .map((skill) => ({
        baseDigest: skill.baseDigest,
        canonicalDigest: skill.canonicalDigest,
        id: skill.id,
        projections: [...skill.projections].sort(compareProjection),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}
