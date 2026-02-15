/**
 * Standalone deploy script for the voting contract.
 *
 * Usage:
 *   npm run build && npm run deploy:voting
 *
 * Prompts for a hex seed (or generates a new one), builds a wallet,
 * waits for sync + funds + dust, deploys the voting contract,
 * and writes deployment-voting.json with the contract address.
 */

import * as readline from "node:readline/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import * as Rx from "rxjs";
import { WebSocket } from "ws";
import pino from "pino";
import pinoPretty from "pino-pretty";

import {
  Contract,
  ledger as votingLedger
} from "./managed/voting/contract/index.js";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { deployContract } from "@midnight-ntwrk/midnight-js-contracts";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import {
  setNetworkId,
  getNetworkId
} from "@midnight-ntwrk/midnight-js-network-id";
import { toHex } from "@midnight-ntwrk/midnight-js-utils";
import type {
  MidnightProvider,
  WalletProvider
} from "@midnight-ntwrk/midnight-js-types";
import type { ImpureCircuitId } from "@midnight-ntwrk/compact-js";
import * as ledger from "@midnight-ntwrk/ledger-v7";

import {
  createKeystore,
  InMemoryTransactionHistoryStorage,
  type UnshieldedKeystore,
  UnshieldedWallet,
  PublicKey
} from "@midnight-ntwrk/wallet-sdk-unshielded-wallet";
import { ShieldedWallet } from "@midnight-ntwrk/wallet-sdk-shielded";
import { DustWallet } from "@midnight-ntwrk/wallet-sdk-dust-wallet";
import { WalletFacade } from "@midnight-ntwrk/wallet-sdk-facade";
import {
  generateRandomSeed,
  HDWallet,
  Roles
} from "@midnight-ntwrk/wallet-sdk-hd";

// @ts-expect-error: needed for apollo WS transport
globalThis.WebSocket = WebSocket;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const INDEXER =
  process.env.INDEXER_URL ?? "http://127.0.0.1:8088/api/v3/graphql";
const INDEXER_WS =
  process.env.INDEXER_WS_URL ?? "ws://127.0.0.1:8088/api/v3/graphql/ws";
const NODE = process.env.NODE_URL ?? "http://127.0.0.1:9944";
const PROOF_SERVER = process.env.PROOF_SERVER_URL ?? "http://127.0.0.1:6300";
const NETWORK_ID = process.env.NETWORK_ID ?? "undeployed";

const currentDir = path.resolve(new URL(import.meta.url).pathname, "..");
const zkConfigPath = path.resolve(currentDir, "..", "src", "managed", "voting");
const deploymentPath = path.resolve(currentDir, "..", "deployment-voting.json");

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------
const logger = pino(
  { level: process.env.DEBUG_LEVEL ?? "info" },
  pinoPretty({
    colorize: true,
    sync: true,
    translateTime: true,
    ignore: "pid,time",
    singleLine: false
  })
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type VotingPrivateState = { readonly [key: string]: unknown };
type VotingCircuits = ImpureCircuitId<Contract<VotingPrivateState>>;
const VotingPrivateStateId = "votingPrivateState" as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

async function withStatus<T>(
  message: string,
  fn: () => Promise<T>
): Promise<T> {
  let i = 0;
  const interval = setInterval(() => {
    process.stdout.write(`\r  ${frames[i++ % frames.length]} ${message}`);
  }, 80);
  try {
    const result = await fn();
    clearInterval(interval);
    process.stdout.write(`\r  ✓ ${message}\n`);
    return result;
  } catch (e) {
    clearInterval(interval);
    process.stdout.write(`\r  ✗ ${message}\n`);
    throw e;
  }
}

function deriveKeysFromSeed(seed: string) {
  const hdWallet = HDWallet.fromSeed(Buffer.from(seed, "hex"));
  if (hdWallet.type !== "seedOk")
    throw new Error("Failed to initialize HDWallet from seed");

  const result = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);

  if (result.type !== "keysDerived") throw new Error("Failed to derive keys");
  hdWallet.hdWallet.clear();
  return result.keys;
}

const formatBalance = (b: bigint) => b.toLocaleString();

// ---------------------------------------------------------------------------
// Wallet build
// ---------------------------------------------------------------------------
async function buildWallet(seed: string) {
  const keys = deriveKeysFromSeed(seed);
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(
    keys[Roles.NightExternal],
    getNetworkId()
  );

  const shieldedWallet = ShieldedWallet({
    networkId: getNetworkId(),
    indexerClientConnection: {
      indexerHttpUrl: INDEXER,
      indexerWsUrl: INDEXER_WS
    },
    provingServerUrl: new URL(PROOF_SERVER),
    relayURL: new URL(NODE.replace(/^http/, "ws"))
  }).startWithSecretKeys(shieldedSecretKeys);

  const unshieldedWallet = UnshieldedWallet({
    networkId: getNetworkId(),
    indexerClientConnection: {
      indexerHttpUrl: INDEXER,
      indexerWsUrl: INDEXER_WS
    },
    txHistoryStorage: new InMemoryTransactionHistoryStorage()
  }).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore));

  const dustWallet = DustWallet({
    networkId: getNetworkId(),
    costParameters: {
      additionalFeeOverhead: 300_000_000_000_000n,
      feeBlocksMargin: 5
    },
    indexerClientConnection: {
      indexerHttpUrl: INDEXER,
      indexerWsUrl: INDEXER_WS
    },
    provingServerUrl: new URL(PROOF_SERVER),
    relayURL: new URL(NODE.replace(/^http/, "ws"))
  } as any).startWithSecretKey(
    dustSecretKey,
    ledger.LedgerParameters.initialParameters().dust
  );

  const wallet = new WalletFacade(shieldedWallet, unshieldedWallet, dustWallet);
  await wallet.start(shieldedSecretKeys, dustSecretKey);

  return { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
}

// ---------------------------------------------------------------------------
// Sign transaction intents
// ---------------------------------------------------------------------------
function signTransactionIntents(
  tx: { intents?: Map<number, any> },
  signFn: (payload: Uint8Array) => ledger.Signature,
  proofMarker: "proof" | "pre-proof"
): void {
  if (!tx.intents || tx.intents.size === 0) return;
  for (const segment of tx.intents.keys()) {
    const intent = tx.intents.get(segment);
    if (!intent) continue;
    const cloned = ledger.Intent.deserialize<
      ledger.SignatureEnabled,
      ledger.Proofish,
      ledger.PreBinding
    >("signature", proofMarker, "pre-binding", intent.serialize());
    const sigData = cloned.signatureData(segment);
    const signature = signFn(sigData);
    if (cloned.fallibleUnshieldedOffer) {
      const sigs = cloned.fallibleUnshieldedOffer.inputs.map(
        (_: ledger.UtxoSpend, i: number) =>
          cloned.fallibleUnshieldedOffer!.signatures.at(i) ?? signature
      );
      cloned.fallibleUnshieldedOffer =
        cloned.fallibleUnshieldedOffer.addSignatures(sigs);
    }
    if (cloned.guaranteedUnshieldedOffer) {
      const sigs = cloned.guaranteedUnshieldedOffer.inputs.map(
        (_: ledger.UtxoSpend, i: number) =>
          cloned.guaranteedUnshieldedOffer!.signatures.at(i) ?? signature
      );
      cloned.guaranteedUnshieldedOffer =
        cloned.guaranteedUnshieldedOffer.addSignatures(sigs);
    }
    tx.intents.set(segment, cloned);
  }
}

// ---------------------------------------------------------------------------
// Provider creation
// ---------------------------------------------------------------------------
function createWalletAndMidnightProvider(
  wallet: WalletFacade,
  shieldedSecretKeys: ledger.ZswapSecretKeys,
  dustSecretKey: ledger.DustSecretKey,
  unshieldedKeystore: UnshieldedKeystore,
  syncedState: any
): WalletProvider & MidnightProvider {
  return {
    getCoinPublicKey: () => syncedState.shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey: () =>
      syncedState.shielded.encryptionPublicKey.toHexString(),
    async balanceTx(tx, ttl) {
      const recipe = await wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys, dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) }
      );
      const signFn = (payload: Uint8Array) =>
        unshieldedKeystore.signData(payload);
      signTransactionIntents(recipe.baseTransaction, signFn, "proof");
      if (recipe.balancingTransaction) {
        signTransactionIntents(
          recipe.balancingTransaction,
          signFn,
          "pre-proof"
        );
      }
      return wallet.finalizeRecipe(recipe);
    },
    async submitTx(tx: ledger.FinalizedTransaction) {
      return wallet.submitTransaction(tx);
    }
  };
}

// ---------------------------------------------------------------------------
// Dust registration
// ---------------------------------------------------------------------------
async function registerForDustGeneration(
  wallet: WalletFacade,
  unshieldedKeystore: UnshieldedKeystore
) {
  const state = await Rx.firstValueFrom(
    wallet.state().pipe(Rx.filter((s) => s.isSynced))
  );

  if (state.dust.availableCoins.length > 0) {
    const dustBal = state.dust.walletBalance(new Date());
    console.log(
      `  ✓ Dust tokens already available (${formatBalance(dustBal)} DUST)`
    );
    return;
  }

  const nightUtxos = state.unshielded.availableCoins.filter(
    (coin: any) => coin.meta?.registeredForDustGeneration !== true
  );

  if (nightUtxos.length > 0) {
    await withStatus(
      `Registering ${nightUtxos.length} NIGHT UTXO(s) for dust generation`,
      async () => {
        const recipe = await wallet.registerNightUtxosForDustGeneration(
          nightUtxos,
          unshieldedKeystore.getPublicKey(),
          (payload) => unshieldedKeystore.signData(payload)
        );
        const finalized = await wallet.finalizeRecipe(recipe);
        await wallet.submitTransaction(finalized);
      }
    );
  }

  await withStatus("Waiting for dust tokens to generate", () =>
    Rx.firstValueFrom(
      wallet.state().pipe(
        Rx.throttleTime(5_000),
        Rx.filter((s) => s.isSynced),
        Rx.filter((s) => s.dust.walletBalance(new Date()) > 0n)
      )
    )
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  setNetworkId(NETWORK_ID);

  console.log("Voting Contract Deploy Script");
  console.log(`Network: ${NETWORK_ID.padEnd(38)}`);

  // --- Seed prompt ---
  const rl = readline.createInterface({ input, output });
  const seedInput = await rl.question(
    "Enter hex seed (leave blank to generate new): "
  );
  rl.close();

  let seed: string;
  if (seedInput.trim()) {
    seed = seedInput.trim();
    console.log(`  Using provided seed: ${seed.slice(0, 8)}...`);
  } else {
    seed = toHex(Buffer.from(generateRandomSeed()));
    console.log(`  Generated new seed: ${seed}`);
    console.log("  ⚠ Save this seed to restore your wallet later!\n");
  }

  // --- Build wallet ---
  const { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore } =
    await withStatus("Building wallet", () => buildWallet(seed));

  console.log(
    `\n  Unshielded address: ${unshieldedKeystore.getBech32Address()}`
  );

  if (NETWORK_ID === "preprod") {
    console.log(
      "  Fund via faucet: https://faucet.preprod.midnight.network/\n"
    );
  } else {
    console.log("");
  }

  // --- Wait for sync ---
  const syncedState = await withStatus("Syncing wallet with network", () =>
    Rx.firstValueFrom(
      wallet.state().pipe(
        Rx.throttleTime(5_000),
        Rx.tap((s) => logger.debug(`Sync status: ${s.isSynced}`)),
        Rx.filter((s) => s.isSynced)
      )
    )
  );

  // --- Wait for funds ---
  const balance =
    (syncedState.unshielded?.balances[ledger.nativeToken().raw] ?? 0n) +
    (syncedState.shielded?.balances[ledger.nativeToken().raw] ?? 0n);

  if (balance === 0n) {
    await withStatus(
      "Waiting for incoming funds (send tNight to address above)",
      () =>
        Rx.firstValueFrom(
          wallet.state().pipe(
            Rx.throttleTime(10_000),
            Rx.tap((s) => {
              const u = s.unshielded?.balances[ledger.nativeToken().raw] ?? 0n;
              logger.debug(`Balance: ${u}`);
            }),
            Rx.filter((s) => s.isSynced),
            Rx.map(
              (s) =>
                (s.unshielded?.balances[ledger.nativeToken().raw] ?? 0n) +
                (s.shielded?.balances[ledger.nativeToken().raw] ?? 0n)
            ),
            Rx.filter((b) => b > 0n)
          )
        )
    );
  } else {
    console.log(`  ✓ Balance: ${formatBalance(balance)} tNight`);
  }

  // --- Dust registration ---
  await registerForDustGeneration(wallet, unshieldedKeystore);

  // --- Build providers ---
  const walletAndMidnightProvider = createWalletAndMidnightProvider(
    wallet,
    shieldedSecretKeys,
    dustSecretKey,
    unshieldedKeystore,
    syncedState
  );

  const zkConfigProvider = new NodeZkConfigProvider<VotingCircuits>(
    zkConfigPath
  );

  const providers = {
    privateStateProvider: levelPrivateStateProvider<
      typeof VotingPrivateStateId
    >({
      privateStateStoreName: "voting-private-state",
      signingKeyStoreName: "signing-keys",
      midnightDbName: "midnight-level-db",
      walletProvider: walletAndMidnightProvider
    }),
    publicDataProvider: indexerPublicDataProvider(INDEXER, INDEXER_WS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(PROOF_SERVER, zkConfigProvider),
    walletProvider: walletAndMidnightProvider,
    midnightProvider: walletAndMidnightProvider
  };

  // --- Compile contract ---
  const votingCompiledContract = CompiledContract.make("voting", Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(zkConfigPath)
  );

  // --- Deploy ---
  const contract = await withStatus(
    "Deploying voting contract (this may take a few minutes)",
    async () => {
      return deployContract(providers, {
        compiledContract: votingCompiledContract,
        privateStateId: VotingPrivateStateId,
        initialPrivateState: {}
      });
    }
  );

  const contractAddress = contract.deployTxData.public.contractAddress;

  // --- Write deployment-voting.json ---
  const deployment = {
    contractAddress,
    network: NETWORK_ID,
    deployedAt: new Date().toISOString(),
    seed
  };

  fs.writeFileSync(deploymentPath, JSON.stringify(deployment, null, 2));

  console.log(`Voting contract deployed successfully!`);
  console.log(`  Address: ${contractAddress}`);
  console.log(`  Saved:   ${deploymentPath}\n`);

  // Cleanup
  try {
    await wallet.stop();
  } catch {
    // ignore cleanup errors
  }

  process.exit(0);
}

main().catch((err) => {
  logger.error(err, "Deploy failed");
  process.exit(1);
});
