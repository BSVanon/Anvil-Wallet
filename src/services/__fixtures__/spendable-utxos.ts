/**
 * Real mainnet script fixtures for the spendable-UTXO resolver's
 * fail-closed filter. Every entry is a real unspent (or once-unspent)
 * output fetched from WhatsOnChain on 2026-04-22. Hex strings are
 * verbatim from `/v1/bsv/main/tx/{txid}` scriptPubKey.hex.
 *
 * These are the ONLY inputs used by spendable-utxos.test.ts — we do
 * not construct scripts by hand from specs because specs evolve
 * (e.g. MNEE's inscription envelope starts with raw OP_IF, not
 * OP_FALSE OP_IF as most 1Sat references document). Real mainnet tx
 * bytes are the only ground truth.
 *
 * How to add a new fixture:
 *  1. Identify a real on-chain UTXO that demonstrates the script
 *     shape you need (or ask Robert for a wallet to pull from —
 *     test wallets in DEX/tests/LIVE_TEST_KEYS.md hold several).
 *  2. Fetch scriptPubKey.hex via WhatsOnChain:
 *     `curl https://api.whatsonchain.com/v1/bsv/main/tx/{txid}`.
 *  3. Paste hex verbatim. Add a comment with the whatsonchain.com
 *     explorer link as provenance. Set expectedFungible based on
 *     what the script actually is, not what you want it to be.
 *  4. Add a matching test case in spendable-utxos.test.ts.
 *
 * DO NOT edit a fixture's hex after the fact. If the chain data
 * changes (e.g. MNEE's envelope shape updates), add a new fixture
 * rather than mutating the existing one — the test history matters.
 */

export interface ScriptFixture {
  /** Short identifier used in test names. */
  name: string;
  /** Human description of the script shape. */
  description: string;
  /** Mainnet txid this output belongs to. */
  txid: string;
  /** Output index within that tx. */
  vout: number;
  /** Raw scriptPubKey hex, lowercase. */
  scriptHex: string;
  /** Length in bytes (for quick sanity checks in tests). */
  lengthBytes: number;
  /**
   * TRUE iff the resolver should treat this output as spendable
   * fungible BSV. Bare P2PKH → true. Ordinal / MNEE / covenant /
   * OP_RETURN / anything non-P2PKH → false (fail-closed).
   */
  expectedFungible: boolean;
  /** WhatsOnChain explorer URL — for anyone verifying the fixture. */
  provenance: string;
}

export const SPENDABLE_UTXO_FIXTURES: ScriptFixture[] = [
  // ── Fixture 1: MNEE production transfer (the Codex-flagged case) ──
  // V1e mainnet pilot, Alice → Bob 100 atomic MNEE on 2026-04-17.
  // CRITICAL: starts with raw OP_IF (0x63), NOT OP_FALSE OP_IF (0x00 0x63).
  // The old envelope filter that required the leading 0x00 MISSES this.
  // Safe only because isBareP2PKH rejects it on the 25-byte length check.
  {
    name: 'mnee-production-transfer',
    description:
      "Real MNEE BSV-21 Cosign output: OP_IF 'ord' <bsv-20 JSON> OP_ENDIF " +
      'P2PKH(owner) OP_CHECKSIGVERIFY <approver pubkey> OP_CHECKSIG. 205 bytes.',
    txid: '02ba121709bbba0da7a4313d3e984836077c4b4abc2a448e1de4361086e4869e',
    vout: 0,
    scriptHex:
      '63036f726451126170706c69636174696f6e2f6273762d3230004c747b2270223a226273762d3230222c226f70223a227472616e73666572222c226964223a22616535396633623839386563363161636264623663633761323435666162656465643063303934626630343666333532303661336165633630656638383132375f30222c22616d74223a22313030227d6876a914685ca239f9476a39132ab6a644a06e62c301ecdc88ad21020a177d6a5e6f3a8689acd2e313bd1cf0dcf5a243d1cc67b7218602aee9e04b2fac',
    lengthBytes: 205,
    expectedFungible: false,
    provenance:
      'https://whatsonchain.com/tx/02ba121709bbba0da7a4313d3e984836077c4b4abc2a448e1de4361086e4869e',
  },

  // ── Fixture 2: Phase 3b AMM covenant ──
  // Mainnet-validated pool covenant from 2026-04-14, block 944836.
  // Custom script (not P2PKH, not inscription) — pure fail-closed test.
  {
    name: 'phase3b-pool-covenant',
    description:
      'Phase 3B AMM pool covenant (constant-product x·y≥k). 1039-byte ' +
      'custom spending script. Not P2PKH, no inscription envelope.',
    txid: '7a0967a6152dbff221fab3bf37023ae6c587a5d364f477ce14ab7d7b1455a54a',
    vout: 0,
    scriptHex:
      '012124deec9a4f9e5cad1016de0ad1ec9a4f9e5cad1016de0ad1ec9a4f9e5cad1016de000000000340420f02c80075756d76aa007c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c7501007e81209817f8165b81f259d928ce2ddbfc9b02070b87ce9562a055acbbdcf97e66be799321414136d08c5ed2bf3ba048afe6dcaebafeffffffffffffffffffffffffffffff0097826b012180007c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c828c7f6b7c6c7e7c756c01217c947f77825180527c7e7c7e22022079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f817987c7e82518001307c7e7c7e01617e210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ad547f77517f7c7601007e817602fd009f637c75677575527f7c01007e81687501247f77517f7c7601007e817602fd009f637c75677575527f7c01007e81687f7c6b012d7f77517f7c7601007e817602fd009f637c75677575527f7c01007e816875587f77517f7c7601007e817602fd009f637c75677575527f7c01007e81687f7c776c7c6e6e537f7701247f756b537f7701247f756c8801277f77517f7c01007e817f7c817c517f7c01007e817f7c817b7c6d537f776b01277f77517f7c01007e817f7c817c517f7c01007e817f7c817b7c6d537f776c8801277f77517f7c01007e817f7c817c517f7c01007e817f7c817b7c6b6b7501277f77517f7c01007e817f7c817c517f7c01007e817f7c817b7c7b756c6c956b956c7ca26951',
    lengthBytes: 1039,
    expectedFungible: false,
    provenance:
      'https://whatsonchain.com/tx/7a0967a6152dbff221fab3bf37023ae6c587a5d364f477ce14ab7d7b1455a54a',
  },

  // ── Fixture 3: Phase 3b fund-change output ──
  // Same tx as fixture 2, vout[1]. Normal P2PKH change back to Alice's
  // WIF address `1MNUbK4uQoNS5yz1erB9rsyuK96Wr22qbm`. Proves a bare-
  // P2PKH in the same tx as a covenant output is still spendable.
  {
    name: 'phase3b-fund-change-p2pkh',
    description: "Bare P2PKH change output from Phase 3B pool deploy.",
    txid: '7a0967a6152dbff221fab3bf37023ae6c587a5d364f477ce14ab7d7b1455a54a',
    vout: 1,
    scriptHex: '76a914df72487d52a0051a29c5325b7af9b35a0664745f88ac',
    lengthBytes: 25,
    expectedFungible: true,
    provenance:
      'https://whatsonchain.com/tx/7a0967a6152dbff221fab3bf37023ae6c587a5d364f477ce14ab7d7b1455a54a',
  },

  // ── Fixture 4: V1e claim output, bare P2PKH ──
  // Output of Alice's claim tx in the V1e MNEE pilot. Bare P2PKH to
  // Alice's Anvil-Wallet receive address `1EJaD8hu5PmBkqdrg6FWegQScm9hhUeYd6`.
  {
    name: 'v1e-claim-p2pkh',
    description: 'Bare P2PKH output from V1e AVOS claim tx.',
    txid: '6fad85e62ce2969924322bcdfbf5f2b523b9b00314d50e574f76ddd8425858a1',
    vout: 0,
    scriptHex: '76a91491ec6d9cbb8a131d8f2961361ae413df2a55d44188ac',
    lengthBytes: 25,
    expectedFungible: true,
    provenance:
      'https://whatsonchain.com/tx/6fad85e62ce2969924322bcdfbf5f2b523b9b00314d50e574f76ddd8425858a1',
  },

  // ── Fixture 5: V1e claim OP_RETURN (AVOS tag) ──
  // Same tx as fixture 4, vout[1]. OP_RETURN-prefixed nulldata with
  // the AVOS:v1 protocol tag. Not spendable at all (OP_RETURN makes
  // output provably unspendable) — resolver should exclude.
  {
    name: 'v1e-claim-op-return',
    description: "OP_RETURN AVOS:v1 tag. Provably unspendable nulldata.",
    txid: '6fad85e62ce2969924322bcdfbf5f2b523b9b00314d50e574f76ddd8425858a1',
    vout: 1,
    scriptHex:
      '6a4341564f533a7631adf0c8c0df54c273c7f71037db1a2a8b1721bd2f50a34a38ab808a8314b1ab900000000000000064685ca239f9476a39132ab6a644a06e62c301ecdc',
    lengthBytes: 69,
    expectedFungible: false,
    provenance:
      'https://whatsonchain.com/tx/6fad85e62ce2969924322bcdfbf5f2b523b9b00314d50e574f76ddd8425858a1',
  },

  // ── Fixture 6: Bob's unspent bare P2PKH ──
  // Independent bare-P2PKH UTXO at Bob's WIF address. 1500 sats,
  // different pkhash from fixtures 3 and 4 (exercises the length
  // check on a different byte sequence).
  {
    name: 'bob-bare-p2pkh',
    description: 'Bare P2PKH unspent at a different address.',
    txid: '1326bf6df9648848ae305c6a6b67ddceea914344d296df612ce182400910b600',
    vout: 0,
    scriptHex: '76a914685ca239f9476a39132ab6a644a06e62c301ecdc88ac',
    lengthBytes: 25,
    expectedFungible: true,
    provenance:
      'https://whatsonchain.com/tx/1326bf6df9648848ae305c6a6b67ddceea914344d296df612ce182400910b600',
  },
];

/**
 * Convenience split — most tests iterate one side or the other.
 * These match expectedFungible == true/false on the fixtures above.
 */
export const FUNGIBLE_FIXTURES = SPENDABLE_UTXO_FIXTURES.filter((f) => f.expectedFungible);
export const NON_FUNGIBLE_FIXTURES = SPENDABLE_UTXO_FIXTURES.filter((f) => !f.expectedFungible);
