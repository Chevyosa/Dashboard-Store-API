import type { Pool } from 'mysql2/promise';
import { withTransaction } from '../config/db.js';
import {
  calculateConsignorLedger,
  type ConsignorLedgerStatus,
  type ConsignorLedgerSummary,
} from '../domain/payout.js';
import { addMoney, parseMoney, ZERO_MONEY, toDbString } from '../domain/money.js';
import { insertAuditEntry } from '../repositories/audit.repository.js';
import { findConsignorById } from '../repositories/consignor.repository.js';
import { OpnameRepository } from '../repositories/opname.repository.js';
import {
  PayoutRepository,
  type ConsignorPaymentEntity,
  type ConsignorAccrualRow,
  type CreatePaymentData,
} from '../repositories/payout.repository.js';
import { AppError } from '../utils/errors.js';
import { systemClock, type Clock } from '../utils/time.js';
import type {
  CreateConsignorPaymentInput,
  ListConsignorPaymentsQuery,
  ListConsignorLedgerQuery,
} from '../validators/payout.js';

export interface PayoutServiceDeps {
  pool: Pool;
  clock?: Clock;
}

export interface AuditMeta {
  ip?: string | null | undefined;
  userAgent?: string | null | undefined;
}

export interface ConsignorLedgerItem {
  consignorId: number;
  consignorName: string;
  phone: string | null;
  isActive: boolean;
  totalAccrual: string;
  totalPayment: string;
  balance: string;
  status: ConsignorLedgerStatus;
}

export interface ConsignorLedgerDetail {
  consignor: {
    id: number;
    name: string;
    phone: string | null;
    note: string | null;
    isActive: boolean;
  };
  summary: {
    totalAccrual: string;
    totalPayment: string;
    balance: string;
    status: ConsignorLedgerStatus;
  };
  accruals: ConsignorAccrualRow[];
  payments: ConsignorPaymentEntity[];
}

export interface ConsignorLedgersOverview {
  totals: {
    totalAccrual: string;
    totalPayment: string;
    totalBalance: string;
    unpaidCount: number;
  };
  ledgers: ConsignorLedgerItem[];
}

export function createPayoutService({ pool, clock = systemClock }: PayoutServiceDeps) {
  const payoutRepo = new PayoutRepository();
  const opnameRepo = new OpnameRepository();

  return {
    async recordPayment(
      userId: number,
      input: CreateConsignorPaymentInput,
      meta?: AuditMeta,
    ): Promise<ConsignorPaymentEntity> {
      const now = clock();

      return withTransaction(pool, async (conn) => {
        const consignor = await findConsignorById(conn, input.consignorId);
        if (!consignor) {
          throw new AppError(404, 'CONSIGNOR_NOT_FOUND', `Penitip dengan ID ${input.consignorId} tidak ditemukan.`);
        }

        if (input.opnameId) {
          const opname = await opnameRepo.findById(input.opnameId, conn);
          if (!opname) {
            throw new AppError(404, 'OPNAME_NOT_FOUND', `Opname dengan ID ${input.opnameId} tidak ditemukan.`);
          }
        }

        const createData: CreatePaymentData = {
          consignorId: input.consignorId,
          opnameId: input.opnameId ?? null,
          amount: input.amount,
          paymentDate: input.paymentDate,
          paymentMethod: input.paymentMethod,
          note: input.note ?? null,
          createdBy: userId,
        };

        const created = await payoutRepo.createPayment(createData, conn);

        await insertAuditEntry(conn, {
          userId,
          action: 'consignor_payment.created',
          entityType: 'consignor_payment',
          entityId: String(created.id),
          after: created,
          ip: meta?.ip ?? null,
          userAgent: meta?.userAgent ?? null,
          at: now,
        });

        return created;
      });
    },

    async deletePayment(userId: number, id: number, meta?: AuditMeta): Promise<void> {
      const now = clock();

      return withTransaction(pool, async (conn) => {
        const existing = await payoutRepo.findPaymentById(id, conn);
        if (!existing) {
          throw new AppError(404, 'PAYMENT_NOT_FOUND', `Bukti pembayaran dengan ID ${id} tidak ditemukan.`);
        }

        await payoutRepo.deletePayment(id, conn);

        await insertAuditEntry(conn, {
          userId,
          action: 'consignor_payment.deleted',
          entityType: 'consignor_payment',
          entityId: String(id),
          before: existing,
          ip: meta?.ip ?? null,
          userAgent: meta?.userAgent ?? null,
          at: now,
        });
      });
    },

    async getConsignorLedger(consignorId: number): Promise<ConsignorLedgerDetail> {
      const consignor = await findConsignorById(pool, consignorId);
      if (!consignor) {
        throw new AppError(404, 'CONSIGNOR_NOT_FOUND', `Penitip dengan ID ${consignorId} tidak ditemukan.`);
      }

      const accruals = await payoutRepo.getAccrualsByConsignor(consignorId, pool);
      const payments = await payoutRepo.getPaymentsByConsignor(consignorId, pool);

      const summary: ConsignorLedgerSummary = calculateConsignorLedger(
        String(consignorId),
        accruals.map((a) => a.payoutDue),
        payments.map((p) => p.amount),
      );

      return {
        consignor: {
          id: consignor.id,
          name: consignor.name,
          phone: consignor.phone,
          note: consignor.note,
          isActive: consignor.isActive,
        },
        summary: {
          totalAccrual: toDbString(summary.totalAccrual),
          totalPayment: toDbString(summary.totalPayment),
          balance: toDbString(summary.balance),
          status: summary.status,
        },
        accruals,
        payments,
      };
    },

    async listConsignorLedgers(query: ListConsignorLedgerQuery): Promise<ConsignorLedgersOverview> {
      const rawRows = await payoutRepo.getAllConsignorsWithFinancials(pool);

      let totalAccrualDecimal = ZERO_MONEY;
      let totalPaymentDecimal = ZERO_MONEY;
      let totalBalanceDecimal = ZERO_MONEY;
      let unpaidCount = 0;

      const items: ConsignorLedgerItem[] = [];

      for (const row of rawRows) {
        const accruals = parseMoney(row.totalAccrual).isZero() ? [] : [row.totalAccrual];
        const payments = parseMoney(row.totalPayment).isZero() ? [] : [row.totalPayment];
        const summary = calculateConsignorLedger(
          String(row.consignorId),
          accruals,
          payments,
        );

        totalAccrualDecimal = addMoney(totalAccrualDecimal, summary.totalAccrual);
        totalPaymentDecimal = addMoney(totalPaymentDecimal, summary.totalPayment);
        totalBalanceDecimal = addMoney(totalBalanceDecimal, summary.balance);

        if (summary.status === 'unpaid') {
          unpaidCount += 1;
        }

        // Apply filters
        if (query.status !== 'all' && summary.status !== query.status) {
          continue;
        }

        if (query.search) {
          const s = query.search.toLowerCase();
          const matchName = row.consignorName.toLowerCase().includes(s);
          const matchPhone = row.phone?.toLowerCase().includes(s);
          if (!matchName && !matchPhone) {
            continue;
          }
        }

        items.push({
          consignorId: row.consignorId,
          consignorName: row.consignorName,
          phone: row.phone,
          isActive: row.isActive,
          totalAccrual: toDbString(summary.totalAccrual),
          totalPayment: toDbString(summary.totalPayment),
          balance: toDbString(summary.balance),
          status: summary.status,
        });
      }

      return {
        totals: {
          totalAccrual: toDbString(totalAccrualDecimal),
          totalPayment: toDbString(totalPaymentDecimal),
          totalBalance: toDbString(totalBalanceDecimal),
          unpaidCount,
        },
        ledgers: items,
      };
    },

    async listPayments(query: ListConsignorPaymentsQuery): Promise<{
      data: ConsignorPaymentEntity[];
      pagination: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
      };
    }> {
      const { data, total } = await payoutRepo.listPayments(
        {
          page: query.page,
          limit: query.limit,
          consignorId: query.consignorId,
          opnameId: query.opnameId,
          startDate: query.startDate,
          endDate: query.endDate,
        },
        pool,
      );

      const totalPages = Math.ceil(total / query.limit) || 1;

      return {
        data,
        pagination: {
          page: query.page,
          limit: query.limit,
          total,
          totalPages,
        },
      };
    },
  };
}
