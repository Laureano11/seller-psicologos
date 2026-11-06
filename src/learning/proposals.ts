import type { Db } from '../db/db.js';
import {
  addManualVersion, addVariant, decideProposal, getProposal, listVariants, setVariantStatus,
} from '../db/repo.js';

export async function approveProposal(db: Db, id: number): Promise<void> {
  const p = await getProposal(db, id);
  if (!p) throw new Error(`Propuesta ${id} inexistente`);
  if (p.status !== 'pendiente') throw new Error(`La propuesta ${id} ya fue decidida (${p.status})`);
  if (p.kind === 'apertura_nueva') {
    await addVariant(db, p.proposedContent, 'candidata', id);
  } else if (p.kind === 'promover_apertura') {
    if (p.targetId == null) throw new Error(`La propuesta ${id} no tiene variante objetivo`);
    for (const v of await listVariants(db, 'activa')) await setVariantStatus(db, v.id, 'retirada');
    await setVariantStatus(db, p.targetId, 'activa');
  } else if (p.kind === 'manual') {
    await addManualVersion(db, 'ventas', p.proposedContent, 'propuesta');
  }
  await decideProposal(db, id, 'aprobada');
}

export async function rejectProposal(db: Db, id: number): Promise<void> {
  await decideProposal(db, id, 'rechazada');
}
