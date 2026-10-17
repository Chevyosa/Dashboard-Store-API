import { Decimal } from 'decimal.js';
import type { Pool } from 'mysql2/promise';
import { withTransaction } from '../config/db.js';
import { parseMoney, toDbString, ZERO_MONEY } from '../domain/money.js';
import { insertAuditEntry } from '../repositories/audit.repository.js';
import {
  TakeProfitRepository,
  type CreateTakeProfitData,
  type TakeProfitEntity,
} from '../repositories/take-profit.repository.js';
import { AppError } from '../utils/errors.js';
import { systemClock, type Clock } from '../utils/time.js';
import type {
  CreateTakeProfitInput,
  ListTakeProfitsQuery,
} from '../validators/take-profit.js';

export interface AuditMeta {
  ip?: string | null | undefined;
  userAgent?: string | null | undefined;
}

export interface TakeProfitServiceDeps {
  pool: Pool;
  clock?: Clock;
}

export interface FormattedTakeProfitOverview {
  latestOpname: {
    id: number;
    opnameDate: string;
    realCash: string;
  } | null;
  totalUnpaidConsignorBalance: string;
  minWorkingCapital: string;
  withdrawnCurrentPeriod: string;
  totalWithdrawnAllTime: string;
  availableToWithdraw: string;
  rawBalance: string;
  isSafe: boolean;
  warningReason: string | null;
}

export function createTakeProfitService({ pool, clock = systemClock }: TakeProfitServiceDeps) {
  const repo = new TakeProfitRepository();

  return {
    async getOverview(): Promise<FormattedTakeProfitOverview> {
      const latestOpname = await repo.getLatestFinalOpname(pool);
      const totalUnpaidConsignorBalance = await repo.getTotalUnpaidConsignorBalance(pool);
      const savedMinCapital = await repo.getSetting('min_working_capital', pool);
      const minWorkingCapital = savedMinCapital ?? '400000.0000';
      const totalWithdrawnAllTime = await repo.getTotalWithdrawnAllTime(pool);

      let withdrawnCurrentPeriod = '0.0000';
      let realCashDec = ZERO_MONEY;
      if (latestOpname) {
        withdrawnCurrentPeriod = await repo.getWithdrawnForOpname(latestOpname.id, pool);
        realCashDec = parseMoney(latestOpname.realCash);
      }

      const unpaidDec = parseMoney(totalUnpaidConsignorBalance);
      const workingCapitalDec = parseMoney(minWorkingCapital);
      const withdrawnPeriodDec = parseMoney(withdrawnCurrentPeriod);

      // Raw balance = realCash - unpaid - workingCapital - withdrawnPeriod
      const rawBalanceDec = realCashDec
        .minus(unpaidDec)
        .minus(workingCapitalDec)
        .minus(withdrawnPeriodDec);

      const availableDec = Decimal.max(0, rawBalanceDec);
      const isSafe = latestOpname !== null && rawBalanceDec.greaterThanOrEqualTo(0);

      let warningReason: string | null = null;
      if (!latestOpname) {
        warningReason = 'Belum ada opname final. Selesaikan opname mingguan terlebih dahulu.';
      } else if (!isSafe) {
        warningReason = 'Kas toko saat ini belum aman untuk ditarik karena belum mencukupi batas modal belanja dan kewajiban penitip.';
      }

      return {
        latestOpname,
        totalUnpaidConsignorBalance: toDbString(unpaidDec),
        minWorkingCapital: toDbString(workingCapitalDec),
        withdrawnCurrentPeriod: toDbString(withdrawnPeriodDec),
        totalWithdrawnAllTime: toDbString(parseMoney(totalWithdrawnAllTime)),
        availableToWithdraw: toDbString(availableDec),
        rawBalance: toDbString(rawBalanceDec),
        isSafe,
        warningReason,
      };
    },

    async updateWorkingCapital(
      userId: number,
      minWorkingCapital: string,
      meta?: AuditMeta,
    ): Promise<string> {
      const now = clock();
      const parsed = parseMoney(minWorkingCapital);
      if (parsed.isNegative()) {
        throw new AppError(400, 'INVALID_AMOUNT', 'Nominal modal tidak boleh negatif');
      }

      const formatted = toDbString(parsed);

      return withTransaction(pool, async (conn) => {
        const previous = await repo.getSetting('min_working_capital', conn);
        await repo.setSetting('min_working_capital', formatted, conn);

        await insertAuditEntry(conn, {
          userId,
          action: 'store_settings.working_capital_updated',
          entityType: 'store_settings',
          entityId: 'min_working_capital',
          before: { minWorkingCapital: previous },
          after: { minWorkingCapital: formatted },
          ip: meta?.ip ?? null,
          userAgent: meta?.userAgent ?? null,
          at: now,
        });

        return formatted;
      });
    },

    async recordTakeProfit(
      userId: number,
      input: CreateTakeProfitInput,
      meta?: AuditMeta,
    ): Promise<TakeProfitEntity> {
      const now = clock();

      return withTransaction(pool, async (conn) => {
        let opnameId = input.opnameId ?? null;
        if (!opnameId) {
          const latest = await repo.getLatestFinalOpname(conn);
          if (latest) {
            opnameId = latest.id;
          }
        }

        const createData: CreateTakeProfitData = {
          opnameId,
          amount: toDbString(parseMoney(input.amount)),
          withdrawalDate: input.withdrawalDate,
          paymentMethod: input.paymentMethod,
          note: input.note ?? null,
          createdBy: userId,
        };

        const created = await repo.createTakeProfit(createData, conn);

        await insertAuditEntry(conn, {
          userId,
          action: 'take_profit.created',
          entityType: 'take_profit',
          entityId: String(created.id),
          after: created,
          ip: meta?.ip ?? null,
          userAgent: meta?.userAgent ?? null,
          at: now,
        });

        return created;
      });
    },

    async deleteTakeProfit(userId: number, id: number, meta?: AuditMeta): Promise<void> {
      const now = clock();

      return withTransaction(pool, async (conn) => {
        const existing = await repo.findById(id, conn);
        if (!existing) {
          throw new AppError(404, 'TAKE_PROFIT_NOT_FOUND', `Catatan penarikan dengan ID ${id} tidak ditemukan.`);
        }

        await repo.deleteTakeProfit(id, conn);

        await insertAuditEntry(conn, {
          userId,
          action: 'take_profit.deleted',
          entityType: 'take_profit',
          entityId: String(id),
          before: existing,
          ip: meta?.ip ?? null,
          userAgent: meta?.userAgent ?? null,
          at: now,
        });
      });
    },

    async listTakeProfits(query: ListTakeProfitsQuery) {
      const page = query.page ?? 1;
      const limit = query.limit ?? 20;

      const { data, total } = await repo.listTakeProfits(
        {
          page,
          limit,
          opnameId: query.opnameId,
          startDate: query.startDate,
          endDate: query.endDate,
        },
        pool,
      );

      const totalPages = Math.ceil(total / limit) || 1;

      return {
        data,
        pagination: {
          page,
          limit,
          total,
          totalPages,
        },
      };
    },
  };
}
