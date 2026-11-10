import { Decimal } from 'decimal.js';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { withTransaction } from '../config/db.js';
import { parseMoney, toDbString, ZERO_MONEY } from '../domain/money.js';
import { insertAuditEntry } from '../repositories/audit.repository.js';
import { LiquidityRepository, type LiquidityCutoverEntity } from '../repositories/liquidity.repository.js';
import {
  TakeProfitRepository,
  type CreateTakeProfitData,
  type TakeProfitEntity,
} from '../repositories/take-profit.repository.js';
import { AppError } from '../utils/errors.js';
import { assertAfterCutover } from './liquidity-cutover.js';
import {
  computeLiquidityPosition,
  MIN_WORKING_CAPITAL_KEY,
  readMinWorkingCapital,
} from './liquidity-position.service.js';
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

type PayoutStatus = 'settled' | 'partial' | 'unpaid';

export interface FormattedTakeProfitOverview {
  latestOpname: {
    id: number;
    opnameDate: string;
    realCash: string;
    totalPayoutDue: string;
  } | null;
  totalPayout: string;
  payoutPaid: string;
  payoutUnpaid: string;
  payoutStatus: PayoutStatus;
  totalUnpaidConsignorBalance: string;
  minWorkingCapital: string;
  withdrawnCurrentPeriod: string;
  totalWithdrawnAllTime: string;
  availableToWithdraw: string;
  rawBalance: string;
  isSafe: boolean;
  warningReason: string | null;
  /** True once the liquidity cutover exists and the figures come from the ledger. */
  liquidityInitialized: boolean;
  /** Ledger cash balance; null before the cutover. */
  currentLiquidBalance: string | null;
  unpaidStockPurchaseBalance: string;
  totalUnpaidObligations: string;
  liquidityShortfall: string;
}

interface PayoutSummary {
  totalPayout: Decimal;
  payoutPaid: Decimal;
  payoutUnpaid: Decimal;
  payoutStatus: PayoutStatus;
}

/**
 * The latest opname's payout (or the unpaid balance, if older debt makes it
 * larger), split into its paid and unpaid parts.
 */
function describePayout(latestPayoutDue: string | undefined, unpaidBalance: Decimal): PayoutSummary {
  const latestPayoutDueDec = latestPayoutDue === undefined ? ZERO_MONEY : parseMoney(latestPayoutDue);
  const totalPayout = Decimal.max(latestPayoutDueDec, unpaidBalance);
  const payoutUnpaid = Decimal.min(totalPayout, unpaidBalance);
  const payoutPaid = Decimal.max(0, totalPayout.minus(payoutUnpaid));

  let payoutStatus: PayoutStatus;
  if (totalPayout.isZero() || payoutUnpaid.isZero()) {
    payoutStatus = 'settled';
  } else if (payoutPaid.greaterThan(0)) {
    payoutStatus = 'partial';
  } else {
    payoutStatus = 'unpaid';
  }
  return { totalPayout, payoutPaid, payoutUnpaid, payoutStatus };
}

function formatPayout(p: PayoutSummary) {
  return {
    totalPayout: toDbString(p.totalPayout),
    payoutPaid: toDbString(p.payoutPaid),
    payoutUnpaid: toDbString(p.payoutUnpaid),
    payoutStatus: p.payoutStatus,
  };
}

export function createTakeProfitService({ pool, clock = systemClock }: TakeProfitServiceDeps) {
  const repo = new TakeProfitRepository();
  const liquidityRepo = new LiquidityRepository();

  async function readCommonOverview(db: Pool | PoolConnection) {
    const latestOpname = await repo.getLatestFinalOpname(db);
    const totalWithdrawnAllTime = await repo.getTotalWithdrawnAllTime(db);
    const withdrawnCurrentPeriod = latestOpname
      ? await repo.getWithdrawnForOpname(latestOpname.id, db)
      : '0.0000';
    return { latestOpname, totalWithdrawnAllTime, withdrawnCurrentPeriod };
  }

  /** Pre-cutover formula: latest opname cash minus payout, working capital and this period's withdrawals. */
  async function getLegacyOverview(): Promise<FormattedTakeProfitOverview> {
    const { latestOpname, totalWithdrawnAllTime, withdrawnCurrentPeriod } = await readCommonOverview(pool);
    const workingCapitalDec = await readMinWorkingCapital(pool);

    const { allTimeAccruals, allTimePayments } = await repo.getPayoutFinancialSummary(pool);
    const unpaidBalanceDec = Decimal.max(0, parseMoney(allTimeAccruals).minus(parseMoney(allTimePayments)));
    const payout = describePayout(latestOpname?.totalPayoutDue, unpaidBalanceDec);

    const realCashDec = latestOpname ? parseMoney(latestOpname.realCash) : ZERO_MONEY;
    const withdrawnPeriodDec = parseMoney(withdrawnCurrentPeriod);

    // Final formula: Uang Masuk (realCash) - Payout (totalPayout) - Minimal Saldo Belanja (workingCapital) - Sudah Ditarik (withdrawnPeriod)
    const rawBalanceDec = realCashDec
      .minus(payout.totalPayout)
      .minus(workingCapitalDec)
      .minus(withdrawnPeriodDec);

    const isSafe = latestOpname !== null && rawBalanceDec.greaterThanOrEqualTo(0);

    let warningReason: string | null = null;
    if (!latestOpname) {
      warningReason = 'Belum ada opname final. Selesaikan opname mingguan terlebih dahulu.';
    } else if (!isSafe) {
      warningReason = 'Kas toko saat ini belum aman untuk ditarik karena belum mencukupi batas modal belanja dan payout penitip.';
    }

    return {
      latestOpname,
      ...formatPayout(payout),
      totalUnpaidConsignorBalance: toDbString(payout.payoutUnpaid),
      minWorkingCapital: toDbString(workingCapitalDec),
      withdrawnCurrentPeriod: toDbString(withdrawnPeriodDec),
      totalWithdrawnAllTime: toDbString(parseMoney(totalWithdrawnAllTime)),
      availableToWithdraw: toDbString(Decimal.max(0, rawBalanceDec)),
      rawBalance: toDbString(rawBalanceDec),
      isSafe,
      warningReason,
      liquidityInitialized: false,
      currentLiquidBalance: null,
      // Supplier debt is not tracked before the cutover.
      unpaidStockPurchaseBalance: toDbString(ZERO_MONEY),
      totalUnpaidObligations: toDbString(payout.payoutUnpaid),
      liquidityShortfall: toDbString(Decimal.max(0, rawBalanceDec.negated())),
    };
  }

  /** Post-cutover: the ledger balance against the reserve plus every unpaid obligation. */
  async function getLedgerOverview(
    cutover: LiquidityCutoverEntity,
    db: PoolConnection,
  ): Promise<FormattedTakeProfitOverview> {
    const { latestOpname, totalWithdrawnAllTime, withdrawnCurrentPeriod } = await readCommonOverview(db);
    const position = await computeLiquidityPosition(cutover, db);
    // Display only: describes the latest payout against the per-consignor unpaid
    // balance. The ledger figures below do not depend on it.
    const payout = describePayout(latestOpname?.totalPayoutDue, position.unpaidConsignorBalance);
    const isSafe = position.shortfall.isZero();

    return {
      latestOpname,
      ...formatPayout(payout),
      totalUnpaidConsignorBalance: toDbString(position.unpaidConsignorBalance),
      minWorkingCapital: toDbString(position.minimumReserve),
      withdrawnCurrentPeriod: toDbString(parseMoney(withdrawnCurrentPeriod)),
      totalWithdrawnAllTime: toDbString(parseMoney(totalWithdrawnAllTime)),
      availableToWithdraw: toDbString(position.safeToWithdraw),
      rawBalance: toDbString(position.surplus),
      isSafe,
      warningReason: isSafe
        ? null
        : 'Kas toko saat ini belum aman untuk ditarik karena saldo likuiditas belum mencukupi cadangan modal belanja dan kewajiban yang belum dibayar.',
      liquidityInitialized: true,
      currentLiquidBalance: toDbString(position.liquidBalance),
      unpaidStockPurchaseBalance: toDbString(position.unpaidStockPurchaseBalance),
      totalUnpaidObligations: toDbString(position.unpaidObligations),
      liquidityShortfall: toDbString(position.shortfall),
    };
  }

  return {
    async getOverview(): Promise<FormattedTakeProfitOverview> {
      const cutover = await liquidityRepo.findCutover(pool);
      if (!cutover) return getLegacyOverview();
      // One transaction, so every ledger and obligation read comes from the same snapshot.
      return withTransaction(pool, (conn) => getLedgerOverview(cutover, conn));
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
        // The reserve feeds the take-profit guard, so it changes under the same
        // common cutover lock and cannot race a withdrawal.
        await liquidityRepo.lockCutoverForUpdate(conn);
        const previous = await repo.getSetting(MIN_WORKING_CAPITAL_KEY, conn);
        await repo.setSetting(MIN_WORKING_CAPITAL_KEY, formatted, conn);

        await insertAuditEntry(conn, {
          userId,
          action: 'store_settings.working_capital_updated',
          entityType: 'store_settings',
          entityId: MIN_WORKING_CAPITAL_KEY,
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
        // Common cutover lock first: serializes with every other liquidity source write.
        const cutover = await liquidityRepo.lockCutoverForUpdate(conn);
        assertAfterCutover(cutover, input.withdrawalDate, 'Penarikan keuntungan');

        if (cutover) {
          // Read on the locked connection: no source write or reserve change can
          // move the position until this transaction ends.
          const position = await computeLiquidityPosition(cutover, conn);
          const amount = parseMoney(input.amount);
          if (amount.greaterThan(position.safeToWithdraw)) {
            throw new AppError(
              409,
              'INSUFFICIENT_LIQUIDITY',
              `Penarikan ${toDbString(amount)} melebihi saldo yang aman ditarik (${toDbString(position.safeToWithdraw)}).`,
            );
          }
        }

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

        if (cutover) {
          await liquidityRepo.appendEvent(
            {
              eventType: 'owner_withdrawal',
              sourceType: 'take_profit',
              sourceId: String(created.id),
              amountDelta: toDbString(parseMoney(created.amount).negated()),
              effectiveDate: created.withdrawalDate,
              createdBy: userId,
            },
            conn,
          );
        }

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
        const cutover = await liquidityRepo.lockCutoverForUpdate(conn);

        const existing = await repo.findById(id, conn);
        if (!existing) {
          throw new AppError(404, 'TAKE_PROFIT_NOT_FOUND', `Catatan penarikan dengan ID ${id} tidak ditemukan.`);
        }
        if (cutover) {
          // The liquidity ledger is append-only once the cutover exists.
          throw new AppError(
            409,
            'LIQUIDITY_HISTORY_LOCKED',
            'Catatan penarikan tidak dapat dihapus setelah cutover saldo karena riwayat likuiditas sudah dikunci.',
          );
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
