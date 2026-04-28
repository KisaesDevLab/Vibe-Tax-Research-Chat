// Phase 25 — Bull Board mounted under /admin/queues.
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter.js';
import { ExpressAdapter } from '@bull-board/express';
import { QUEUES } from '../../jobs/queues.js';

export function mountBullBoard(): ExpressAdapter {
  const adapter = new ExpressAdapter();
  adapter.setBasePath('/admin/queues');
  createBullBoard({
    queues: QUEUES.map((q) => new BullMQAdapter(q)),
    serverAdapter: adapter,
  });
  return adapter;
}
