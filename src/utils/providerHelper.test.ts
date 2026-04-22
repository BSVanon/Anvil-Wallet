import { mapGpOrdinal } from './providerHelper';
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
