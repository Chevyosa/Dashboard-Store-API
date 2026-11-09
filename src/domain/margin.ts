import { Decimal } from 'decimal.js';
import {
  InvalidMarginError,
  InvalidPercentageError,
  InvalidQuantityError,
} from './errors.js';
import {
  mulMoney,
  parseMoney,
  subMoney,
  ZERO_MONEY,
  type MoneyInput,
} from './money.js';

export interface OwnMarginResult {
  sellPrice: Decimal;
  avgCost: Decimal;
  pcsPerPack: number;
  marginPerPcs: Decimal;
  marginPerPack: Decimal;
}

export type MarginScheme =
  | { type: 'nominal'; marginValue: MoneyInput }
  | { type: 'percent'; marginPercentage: MoneyInput };

export interface ConsignorMarginResult {
  sellPrice: Decimal;
  scheme: MarginScheme;
  ownerMarginPerPcs: Decimal;
  consignorSharePerPcs: Decimal;
}

/**
 * Calculates margin for an own product (owner_type = 'own', §5.2).
 * margin_per_pcs = sell_price - avg_cost
 * margin_per_pack = margin_per_pcs * pcs_per_pack
 */
export function calculateOwnMargin(
  sellPriceInput: MoneyInput,
  avgCostInput: MoneyInput,
  pcsPerPack = 1,
): OwnMarginResult {
  if (!Number.isInteger(pcsPerPack) || pcsPerPack < 1) {
    throw new InvalidQuantityError('Isi per pack (pcs_per_pack) harus berupa bilangan bulat minimal 1');
  }

  const sellPrice = parseMoney(sellPriceInput);
  const avgCost = parseMoney(avgCostInput);

  if (sellPrice.isNegative()) {
    throw new InvalidMarginError('Harga jual tidak boleh negatif');
  }
  if (avgCost.isNegative()) {
    throw new InvalidMarginError('Modal (avg_cost) tidak boleh negatif');
  }

  const marginPerPcs = subMoney(sellPrice, avgCost);
  const marginPerPack = mulMoney(marginPerPcs, pcsPerPack.toString());

  return {
    sellPrice,
    avgCost,
    pcsPerPack,
    marginPerPcs,
    marginPerPack,
  };
}

/**
 * Calculates margin and consignor share for a consignor product (owner_type = 'consignor', §5.2).
 * Skema nominal:
 *   owner_margin_per_pcs = margin_value
 *   Validasi: 0 <= margin_value < sell_price
 * Skema percent:
 *   owner_margin_per_pcs = sell_price * (pct / 100)
 *   Validasi: 0 < pct < 100 (BR-03)
 * Keduanya:
 *   consignor_share_per_pcs = sell_price - owner_margin_per_pcs
 * Invarian I5:
 *   owner_margin_per_pcs + consignor_share_per_pcs === sell_price
 */
export function calculateConsignorMargin(
  sellPriceInput: MoneyInput,
  scheme: MarginScheme,
): ConsignorMarginResult {
  const sellPrice = parseMoney(sellPriceInput);

  if (sellPrice.lte(ZERO_MONEY)) {
    throw new InvalidMarginError('Harga jual produk titipan harus lebih besar dari 0');
  }

  let ownerMarginPerPcs: Decimal;

  if (scheme.type === 'nominal') {
    const marginValue = parseMoney(scheme.marginValue);

    // 0 <= margin_value < sell_price (§5.2)
    if (marginValue.isNegative() || marginValue.gte(sellPrice)) {
      throw new InvalidMarginError(
        'Margin nominal harus lebih besar atau sama dengan nol dan kurang dari harga jual',
      );
    }
    ownerMarginPerPcs = marginValue;
  } else if (scheme.type === 'percent') {
    const pct = parseMoney(scheme.marginPercentage);

    // 0 < pct < 100 (BR-03)
    if (pct.lte(ZERO_MONEY) || pct.gte(new Decimal(100))) {
      throw new InvalidPercentageError(
        'Persentase margin harus lebih besar dari 0% dan kurang dari 100%',
      );
    }

    // owner_margin_per_pcs = sell_price * pct / 100 (§5.2, G3, G10, G11)
    ownerMarginPerPcs = sellPrice.times(pct).dividedBy(new Decimal(100));
  } else {
    throw new InvalidMarginError('Skema margin titipan harus "nominal" atau "percent"');
  }

  const consignorSharePerPcs = subMoney(sellPrice, ownerMarginPerPcs);

  return {
    sellPrice,
    scheme,
    ownerMarginPerPcs,
    consignorSharePerPcs,
  };
}
