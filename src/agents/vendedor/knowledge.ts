import type { Db } from '../../db/db.js';
import { getActiveManual, listFaq } from '../../db/repo.js';

export type Knowledge = { ventas: string; producto: string; estilo: string; faq: { question: string; answer: string }[] };

export async function loadKnowledge(db: Db): Promise<Knowledge> {
  const [ventas, producto, estilo, faq] = await Promise.all([
    getActiveManual(db, 'ventas'),
    getActiveManual(db, 'producto'),
    getActiveManual(db, 'estilo'),
    listFaq(db),
  ]);
  return { ventas, producto, estilo, faq: faq.map((f) => ({ question: f.question, answer: f.answer })) };
}
