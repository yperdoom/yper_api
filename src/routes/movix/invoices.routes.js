import Invoice from '../../models/movix/Invoice.js';
import StockMovement from '../../models/movix/StockMovement.js';
import { crudRoutes } from '../../lib/crud.js';
import { applyMovement, revertMovement } from '../../services/stock.service.js';
import { httpError } from '../../lib/errors.js';

async function list(request) {
  const filter = {};
  if (request.query.type) filter.type = request.query.type;
  if (request.query.status) filter.status = request.query.status;

  const invoices = await Invoice.find(filter)
    .populate('supplier', 'name document')
    .sort({ issueDate: -1 })
    .lean();

  return { invoices };
}

/** So rascunho pode ser editado ou apagado; o resto e historico fiscal. */
async function draftOnly(request) {
  const invoice = await Invoice.findById(request.params.id);
  if (!invoice) throw httpError(404, 'Not found');
  if (invoice.status !== 'draft') {
    throw httpError(409, `Invoice is ${invoice.status}; cancel it instead`);
  }
}

const crud = crudRoutes(Invoice, {
  plural: 'invoices',
  single: 'invoice',
  sort: { issueDate: -1 },
  populate: ['supplier', 'items.product'],
  list,
  beforeUpdate: draftOnly,
  beforeDelete: draftOnly,
});

export default async function invoiceRoutes(fastify) {
  /**
   * Confirma a nota e gera um movimento de estoque por item.
   * Nota de entrada soma, nota de saida subtrai.
   */
  fastify.post('/:id/confirm', async (request) => {
    const invoice = await Invoice.findById(request.params.id);
    if (!invoice) throw httpError(404, 'Not found');
    if (invoice.status !== 'draft') {
      throw httpError(409, `Invoice is ${invoice.status} and cannot be confirmed`);
    }
    if (invoice.items.length === 0) {
      throw httpError(400, 'Invoice has no items');
    }

    for (const item of invoice.items) {
      await applyMovement({
        product: item.product,
        type: invoice.type,
        quantity: item.quantity,
        unitCost: item.unitPrice,
        reason: `NF ${invoice.number}/${invoice.series}`,
        invoice: invoice._id,
        user: request.user.userId,
        occurredAt: invoice.issueDate,
      });
    }

    invoice.status = 'confirmed';
    invoice.confirmedAt = new Date();
    await invoice.save();

    return { invoice };
  });

  /** Cancela a nota e estorna os movimentos que ela tinha gerado. */
  fastify.post('/:id/cancel', async (request) => {
    const invoice = await Invoice.findById(request.params.id);
    if (!invoice) throw httpError(404, 'Not found');
    if (invoice.status === 'cancelled') throw httpError(409, 'Invoice already cancelled');

    if (invoice.status === 'confirmed') {
      const movements = await StockMovement.find({ invoice: invoice._id });
      for (const movement of movements) {
        await revertMovement(movement, {
          user: request.user.userId,
          reason: `Cancelamento da NF ${invoice.number}/${invoice.series}`,
        });
      }
    }

    invoice.status = 'cancelled';
    invoice.cancelledAt = new Date();
    await invoice.save();

    return { invoice };
  });

  await fastify.register(crud);
}
