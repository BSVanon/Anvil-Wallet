import { mapGpOrdinal, mapGpHistoryToTxLogs } from './providerHelper';
import { GpOrdinalRow } from '../services/types/gorillaPool.ordinal';

describe('mapGpOrdinal', () => {
  const baseRow: GpOrdinalRow = {
    txid: 'abc123',
    vout: 0,
    outpoint: 'abc123_0',
    satoshis: 1,
    height: 944988,
    idx: '30410',
    owner: null,
    spend: '',
    origin: {
      outpoint: 'origin_tx_0',
      num: '0944988:30410:0',
      data: {
        insc: {
          file: {
            hash: 'filehash',
            size: 1234,
            type: 'image/png',
          },
        },
      },
    },
    data: {
      insc: {
        file: {
          hash: 'filehash',
          size: 1234,
          type: 'image/png',
        },
      },
    },
  };

  it('maps core fields through unchanged', () => {
    const ord = mapGpOrdinal(baseRow, '1ABCowner');
    expect(ord.txid).toBe('abc123');
    expect(ord.vout).toBe(0);
    expect(ord.outpoint).toBe('abc123_0');
    expect(ord.satoshis).toBe(1);
  });

  it('uses row.owner when present, falls back to param', () => {
    const withOwner = { ...baseRow, owner: '1PrimaryOwner' };
    expect(mapGpOrdinal(withOwner, '1Fallback').owner).toBe('1PrimaryOwner');

    const noOwner = { ...baseRow, owner: null };
    expect(mapGpOrdinal(noOwner, '1Fallback').owner).toBe('1Fallback');
  });

  it('preserves origin.outpoint for image rendering (UI uses /content/<origin.outpoint>)', () => {
    const ord = mapGpOrdinal(baseRow, '');
    expect(ord.origin?.outpoint).toBe('origin_tx_0');
  });

  it('preserves origin.data.insc.file.type for UI mime filtering', () => {
    const ord = mapGpOrdinal(baseRow, '');
    expect(ord.origin?.data?.insc?.file?.type).toBe('image/png');
  });

  it('handles a BSV-20 transfer row (json inscription)', () => {
    const bsv20: GpOrdinalRow = {
      ...baseRow,
      origin: {
        outpoint: 'bsv20_origin_0',
        data: {
          insc: {
            file: {
              hash: 'h',
              size: 119,
              type: 'application/bsv-20',
              json: {
                p: 'bsv-20',
                id: 'ae59f3b898ec61acbdb6cc7a245fabeded0c094bf046f35206a3aec60ef88127_0',
                op: 'transfer',
                amt: '424420',
              },
            },
          },
          bsv20: {
            id: 'ae59f3b898ec61acbdb6cc7a245fabeded0c094bf046f35206a3aec60ef88127_0',
            op: 'transfer',
            amt: 424420,
          },
        },
      },
      data: {
        insc: {
          file: {
            hash: 'h',
            size: 118,
            type: 'application/bsv-20',
          },
        },
        bsv20: {
          id: 'ae59f3b898ec61acbdb6cc7a245fabeded0c094bf046f35206a3aec60ef88127_0',
          op: 'transfer',
          amt: 100000,
        },
      },
    };
    const ord = mapGpOrdinal(bsv20, '');
    expect(ord.data?.bsv20?.amt).toBe(100000);
    expect(ord.data?.bsv20?.id).toBe('ae59f3b898ec61acbdb6cc7a245fabeded0c094bf046f35206a3aec60ef88127_0');
    // JSON content should be preserved for origin so callers can
    // inspect the inscription payload.
    expect(ord.origin?.data?.insc?.file?.json).toBeDefined();
  });

  it('handles rows with null data (fund UTXO mistakenly passed in)', () => {
    const bare: GpOrdinalRow = { ...baseRow, data: null, origin: null };
    const ord = mapGpOrdinal(bare, '1X');
    expect(ord.data).toBeFalsy();
    expect(ord.origin).toBeFalsy();
  });

  it('leaves script as empty string (spend path requires spv-store)', () => {
    const ord = mapGpOrdinal(baseRow, '');
    // Display-only mapping — spending an ordinal requires the full
    // Txo shape from spv-store. Callers of the fallback path should
    // treat this as display-only.
    expect(ord.script).toBe('');
  });
});

describe('mapGpHistoryToTxLogs', () => {
  function row(
    overrides: Partial<GpOrdinalRow>,
  ): GpOrdinalRow {
    return {
      txid: 'tx1',
      vout: 0,
      outpoint: 'tx1_0',
      satoshis: 100,
      height: 944000,
      idx: '1',
      owner: '1ABC',
      spend: '',
      origin: null,
      data: null,
      ...overrides,
    };
  }

  it('returns empty for empty input', () => {
    expect(mapGpHistoryToTxLogs([])).toEqual([]);
  });

  it('groups multiple outputs from the same tx into one TxLog', () => {
    const logs = mapGpHistoryToTxLogs([
      row({ txid: 'tx1', vout: 0, satoshis: 100 }),
      row({ txid: 'tx1', vout: 1, satoshis: 200 }),
    ]);
    expect(logs.length).toBe(1);
    expect(logs[0].txid).toBe('tx1');
    expect(logs[0].summary?.fund?.amount).toBe(300);
  });

  it('produces separate TxLogs for different txids', () => {
    const logs = mapGpHistoryToTxLogs([
      row({ txid: 'tx1', satoshis: 100, height: 944000, idx: '1' }),
      row({ txid: 'tx2', satoshis: 200, height: 944001, idx: '1' }),
    ]);
    expect(logs.length).toBe(2);
    const txids = logs.map((l) => l.txid);
    expect(txids).toContain('tx1');
    expect(txids).toContain('tx2');
  });

  it('sorts by height descending (most recent first)', () => {
    const logs = mapGpHistoryToTxLogs([
      row({ txid: 'tx-old', height: 944000, idx: '1' }),
      row({ txid: 'tx-new', height: 944999, idx: '1' }),
      row({ txid: 'tx-mid', height: 944500, idx: '1' }),
    ]);
    expect(logs.map((l) => l.txid)).toEqual(['tx-new', 'tx-mid', 'tx-old']);
  });

  it('tags ordinal-bearing txs with origin summary (not fund)', () => {
    const logs = mapGpHistoryToTxLogs([
      row({
        txid: 'nft-tx',
        satoshis: 1,
        origin: {
          outpoint: 'nft-tx_0',
          data: { insc: { file: { type: 'image/png' } } },
        },
      }),
    ]);
    expect(logs[0].summary?.origin).toBeDefined();
    expect(logs[0].summary?.fund).toBeUndefined();
  });

  it('marks fallback source so callers can tell tier apart', () => {
    const logs = mapGpHistoryToTxLogs([row({ txid: 'tx1' })]);
    expect(logs[0].source).toBe('gorillapool-fallback');
  });

  it('skips rows without a txid', () => {
    const logs = mapGpHistoryToTxLogs([
      row({ txid: '' }),
      row({ txid: 'real-tx', satoshis: 500 }),
    ]);
    expect(logs.length).toBe(1);
    expect(logs[0].txid).toBe('real-tx');
  });

  it('emits a send TxLog when a row has a non-empty spend field', () => {
    // One output received at address, later spent by another tx.
    // Expect two TxLogs: receive (positive amount) + send (negative).
    const logs = mapGpHistoryToTxLogs([
      row({
        txid: 'receive-tx',
        satoshis: 500,
        spend: 'spend-tx',
      }),
    ]);
    const receive = logs.find((l) => l.txid === 'receive-tx');
    const send = logs.find((l) => l.txid === 'spend-tx');
    expect(receive).toBeDefined();
    expect(send).toBeDefined();
    expect(receive!.summary?.fund?.amount).toBe(500);
    expect(send!.summary?.fund?.amount).toBe(-500);
  });

  it('aggregates multi-input sends across rows into one send TxLog', () => {
    // Two separate outputs at the address, both spent in the same tx.
    // The send-side aggregation should sum them into a single
    // send event with total spent.
    const logs = mapGpHistoryToTxLogs([
      row({ txid: 'in-tx-a', satoshis: 300, spend: 'out-tx' }),
      row({ txid: 'in-tx-b', satoshis: 700, spend: 'out-tx' }),
    ]);
    const send = logs.find((l) => l.txid === 'out-tx');
    expect(send).toBeDefined();
    expect(send!.summary?.fund?.amount).toBe(-1000);
  });

  it('does not create a send entry when spend is empty string (still unspent)', () => {
    const logs = mapGpHistoryToTxLogs([row({ txid: 'tx1', spend: '' })]);
    expect(logs.length).toBe(1);
    expect(logs[0].txid).toBe('tx1');
  });

  it('mempool / height=0 txs sort above confirmed ones (fresh broadcasts at top)', () => {
    const logs = mapGpHistoryToTxLogs([
      row({ txid: 'confirmed', height: 944000, idx: '1' }),
      row({ txid: 'mempool', height: 0, idx: '0' }),
    ]);
    expect(logs[0].txid).toBe('mempool');
    expect(logs[1].txid).toBe('confirmed');
  });
});
