export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class NegativeDiffStockError extends DomainError {
  constructor(message = 'Stok fisik lebih banyak dari stok teoritis, cek barang masuk yang belum tercatat') {
    super('NEGATIVE_DIFF_STOCK', message);
    this.name = 'NegativeDiffStockError';
  }
}

export class LossExceedsDiffStockError extends DomainError {
  constructor(message = 'Loss melebihi selisih stok') {
    super('LOSS_EXCEEDS_DIFF_STOCK', message);
    this.name = 'LossExceedsDiffStockError';
  }
}

export class InvalidMarginError extends DomainError {
  constructor(message = 'Margin harus lebih besar atau sama dengan nol dan kurang dari harga jual') {
    super('INVALID_MARGIN', message);
    this.name = 'InvalidMarginError';
  }
}

export class InvalidPercentageError extends DomainError {
  constructor(message = 'Persentase margin harus lebih besar dari 0% dan kurang dari 100%') {
    super('INVALID_PERCENTAGE', message);
    this.name = 'InvalidPercentageError';
  }
}

export class InvalidLossBorneByError extends DomainError {
  constructor(message = 'Loss produk milik sendiri harus ditanggung oleh owner') {
    super('INVALID_LOSS_BORNE_BY', message);
    this.name = 'InvalidLossBorneByError';
  }
}

export class InvalidQuantityError extends DomainError {
  constructor(message = 'Jumlah stok harus bilangan bulat non-negatif') {
    super('INVALID_QUANTITY', message);
    this.name = 'InvalidQuantityError';
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message = 'Nilai uang tidak valid') {
    super('INVALID_MONEY', message);
    this.name = 'InvalidMoneyError';
  }
}
