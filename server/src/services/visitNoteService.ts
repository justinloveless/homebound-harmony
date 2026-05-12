import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { evvVisits, visitNotes, taskTemplates } from '../db/schema';
import { validateAndSave } from './visitValidation';

export interface TaskItem {
  id: string;
  label: string;
  completed: boolean;
}

export async function getNotesForVisit(tenantId: string, evvVisitId: string) {
  const visit = await db
    .select({ id: evvVisits.id })
    .from(evvVisits)
    .where(and(eq(evvVisits.id, evvVisitId), eq(evvVisits.tenantId, tenantId)))
    .limit(1);
  if (!visit[0]) throw new Error('Visit not found');

  return db
    .select()
    .from(visitNotes)
    .where(eq(visitNotes.evvVisitId, evvVisitId))
    .orderBy(asc(visitNotes.version));
}

export async function upsertDraftNote(
  tenantId: string,
  evvVisitId: string,
  authorUserId: string,
  patch: { tasksCompleted?: TaskItem[]; freeText?: string },
) {
  const visit = await db
    .select({ id: evvVisits.id })
    .from(evvVisits)
    .where(and(eq(evvVisits.id, evvVisitId), eq(evvVisits.tenantId, tenantId)))
    .limit(1);
  if (!visit[0]) throw new Error('Visit not found');

  const existing = await db
    .select()
    .from(visitNotes)
    .where(eq(visitNotes.evvVisitId, evvVisitId))
    .orderBy(desc(visitNotes.version))
    .limit(1);

  if (existing[0] && !existing[0].isFinal) {
    const [updated] = await db
      .update(visitNotes)
      .set({
        ...(patch.tasksCompleted !== undefined && { tasksCompleted: patch.tasksCompleted }),
        ...(patch.freeText !== undefined && { freeText: patch.freeText }),
      })
      .where(eq(visitNotes.id, existing[0].id))
      .returning();
    return updated;
  }

  const nextVersion = existing[0] ? existing[0].version + 1 : 1;
  const [created] = await db
    .insert(visitNotes)
    .values({
      evvVisitId,
      version: nextVersion,
      authorUserId,
      tasksCompleted: patch.tasksCompleted ?? [],
      freeText: patch.freeText ?? '',
    })
    .returning();
  return created;
}

export async function signNote(
  tenantId: string,
  noteId: string,
  evvVisitId: string,
  signature: string,
) {
  const visit = await db
    .select({ id: evvVisits.id })
    .from(evvVisits)
    .where(and(eq(evvVisits.id, evvVisitId), eq(evvVisits.tenantId, tenantId)))
    .limit(1);
  if (!visit[0]) throw new Error('Visit not found');

  const [note] = await db
    .select()
    .from(visitNotes)
    .where(and(eq(visitNotes.id, noteId), eq(visitNotes.evvVisitId, evvVisitId)))
    .limit(1);
  if (!note) throw new Error('Note not found');
  if (note.isFinal) throw new Error('Note already finalized');

  const now = new Date();
  const [signed] = await db
    .update(visitNotes)
    .set({
      caregiverSignature: signature,
      signedAt: now,
      submittedAt: now,
      isFinal: true,
    })
    .where(eq(visitNotes.id, noteId))
    .returning();

  await db
    .update(evvVisits)
    .set({ noteStatus: 'complete', updatedAt: now })
    .where(eq(evvVisits.id, evvVisitId));

  await validateAndSave(tenantId, evvVisitId);

  return signed;
}

export async function getTaskTemplatesForTenant(tenantId: string) {
  return db
    .select()
    .from(taskTemplates)
    .where(and(eq(taskTemplates.tenantId, tenantId), eq(taskTemplates.isActive, true)))
    .orderBy(asc(taskTemplates.sortOrder), asc(taskTemplates.createdAt));
}

export async function createTaskTemplate(
  tenantId: string,
  data: { label: string; category?: string; sortOrder?: number },
) {
  const [created] = await db
    .insert(taskTemplates)
    .values({
      tenantId,
      label: data.label,
      category: data.category ?? 'general',
      sortOrder: data.sortOrder ?? 0,
    })
    .returning();
  return created;
}

export async function updateTaskTemplate(
  tenantId: string,
  id: string,
  data: { label?: string; category?: string; sortOrder?: number; isActive?: boolean },
) {
  const [updated] = await db
    .update(taskTemplates)
    .set({
      ...(data.label !== undefined && { label: data.label }),
      ...(data.category !== undefined && { category: data.category }),
      ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
      ...(data.isActive !== undefined && { isActive: data.isActive }),
    })
    .where(and(eq(taskTemplates.id, id), eq(taskTemplates.tenantId, tenantId)))
    .returning();
  if (!updated) throw new Error('Template not found');
  return updated;
}
