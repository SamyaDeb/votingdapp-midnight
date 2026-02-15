/**
 * Backend API server for the Voting dApp frontend.
 * Handles wallet connection and contract interactions via REST endpoints.
 * Runs in Node.js where the Midnight SDK works natively.
 */

import * as http from "node:http";
import * as path from "node:path";
import * as Rx from "rxjs";
import { WebSocket } from "ws";
import pino from "pino";
import pinoPretty from "pino-pretty";

import {
    Contract,
    ledger as votingLedger,
} from "./managed/voting/contract/index.js";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import {
    findDeployedContract,
} from "@midnight-ntwrk/midnight-js-contracts";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import {
    setNetworkId,
    getNetworkId,
} from "@midnight-ntwrk/midnight-js-network-id";
import type {
    MidnightProvider,
    WalletProvider,
} from "@midnight-ntwrk/midnight-js-types";
import type { ImpureCircuitId } from "@midnight-ntwrk/compact-js";
import * as ledger from "@midnight-ntwrk/ledger-v7";

import {
    createKeystore,
    InMemoryTransactionHistoryStorage,
    type UnshieldedKeystore,
    UnshieldedWallet,
    PublicKey,
} from "@midnight-ntwrk/wallet-sdk-unshielded-wallet";
import { ShieldedWallet } from "@midnight-ntwrk/wallet-sdk-shielded";
import { DustWallet } from "@midnight-ntwrk/wallet-sdk-dust-wallet";
import { WalletFacade } from "@midnight-ntwrk/wallet-sdk-facade";
import { HDWallet, Roles } from "@midnight-ntwrk/wallet-sdk-hd";

// @ts-expect-error: needed for apollo WS transport
globalThis.WebSocket = WebSocket;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const INDEXER = process.env.INDEXER_URL ?? "http://127.0.0.1:8088/api/v3/graphql";
const INDEXER_WS = process.env.INDEXER_WS_URL ?? "ws://127.0.0.1:8088/api/v3/graphql/ws";
const NODE = process.env.NODE_URL ?? "http://127.0.0.1:9944";
const PROOF_SERVER = process.env.PROOF_SERVER_URL ?? "http://127.0.0.1:6300";
const NETWORK_ID = process.env.NETWORK_ID ?? "undeployed";
const PORT = parseInt(process.env.PORT ?? "4000", 10);

const SEED = "b6bac8d4e48cb6f6171c6809a6e5abe844dcda240e125fba40537e7b7ad9cd84";
const CONTRACT_ADDRESS = "122c0386e9c9e6e9b5b1248d028e1f628a87c3068391d45cad4b97462bc8a592";

const currentDir = path.resolve(new URL(import.meta.url).pathname, "..");
const zkConfigPath = path.resolve(currentDir, "..", "src", "managed", "voting");

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------
const logger = pino(
    { level: process.env.DEBUG_LEVEL ?? "info" },
    pinoPretty({ colorize: true, sync: true, translateTime: true, ignore: "pid,time", singleLine: false })
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
function deriveKeysFromSeed(seed: string) {
    const hdWallet = HDWallet.fromSeed(Buffer.from(seed, "hex"));
    if (hdWallet.type !== "seedOk") throw new Error("Failed to initialize HDWallet from seed");
    const result = hdWallet.hdWallet.selectAccount(0).selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust]).deriveKeysAt(0);
    if (result.type !== "keysDerived") throw new Error("Failed to derive keys");
    hdWallet.hdWallet.clear();
    return result.keys;
}

function signTransactionIntents(
    tx: { intents?: Map<number, any> },
    signFn: (payload: Uint8Array) => ledger.Signature,
    proofMarker: "proof" | "pre-proof"
): void {
    if (!tx.intents || tx.intents.size === 0) return;
    for (const segment of tx.intents.keys()) {
        const intent = tx.intents.get(segment);
        if (!intent) continue;
        const cloned = ledger.Intent.deserialize<ledger.SignatureEnabled, ledger.Proofish, ledger.PreBinding>(
            "signature", proofMarker, "pre-binding", intent.serialize()
        );
        const sigData = cloned.signatureData(segment);
        const signature = signFn(sigData);
        if (cloned.fallibleUnshieldedOffer) {
            const sigs = cloned.fallibleUnshieldedOffer.inputs.map(
                (_: ledger.UtxoSpend, i: number) => cloned.fallibleUnshieldedOffer!.signatures.at(i) ?? signature
            );
            cloned.fallibleUnshieldedOffer = cloned.fallibleUnshieldedOffer.addSignatures(sigs);
        }
        if (cloned.guaranteedUnshieldedOffer) {
            const sigs = cloned.guaranteedUnshieldedOffer.inputs.map(
                (_: ledger.UtxoSpend, i: number) => cloned.guaranteedUnshieldedOffer!.signatures.at(i) ?? signature
            );
            cloned.guaranteedUnshieldedOffer = cloned.guaranteedUnshieldedOffer.addSignatures(sigs);
        }
        tx.intents.set(segment, cloned);
    }
}

// ---------------------------------------------------------------------------
// Wallet build (reuses deploy script logic)
// ---------------------------------------------------------------------------
async function buildWallet(seed: string) {
    const keys = deriveKeysFromSeed(seed);
    const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
    const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
    const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], getNetworkId());

    const shieldedWallet = ShieldedWallet({
        networkId: getNetworkId(),
        indexerClientConnection: { indexerHttpUrl: INDEXER, indexerWsUrl: INDEXER_WS },
        provingServerUrl: new URL(PROOF_SERVER),
        relayURL: new URL(NODE.replace(/^http/, "ws")),
    }).startWithSecretKeys(shieldedSecretKeys);

    const unshieldedWallet = UnshieldedWallet({
        networkId: getNetworkId(),
        indexerClientConnection: { indexerHttpUrl: INDEXER, indexerWsUrl: INDEXER_WS },
        txHistoryStorage: new InMemoryTransactionHistoryStorage(),
    }).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore));

    const dustWallet = DustWallet({
        networkId: getNetworkId(),
        costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
        indexerClientConnection: { indexerHttpUrl: INDEXER, indexerWsUrl: INDEXER_WS },
        provingServerUrl: new URL(PROOF_SERVER),
        relayURL: new URL(NODE.replace(/^http/, "ws")),
    } as any).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust);

    const wallet = new WalletFacade(shieldedWallet, unshieldedWallet, dustWallet);
    await wallet.start(shieldedSecretKeys, dustSecretKey);

    return { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
}

function createWalletAndMidnightProvider(
    wallet: WalletFacade,
    shieldedSecretKeys: ledger.ZswapSecretKeys,
    dustSecretKey: ledger.DustSecretKey,
    unshieldedKeystore: UnshieldedKeystore,
    syncedState: any
): WalletProvider & MidnightProvider {
    return {
        getCoinPublicKey: () => syncedState.shielded.coinPublicKey.toHexString(),
        getEncryptionPublicKey: () => syncedState.shielded.encryptionPublicKey.toHexString(),
        async balanceTx(tx, ttl) {
            const recipe = await wallet.balanceUnboundTransaction(
                tx,
                { shieldedSecretKeys, dustSecretKey },
                { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) }
            );
            const signFn = (payload: Uint8Array) => unshieldedKeystore.signData(payload);
            signTransactionIntents(recipe.baseTransaction, signFn, "proof");
            if (recipe.balancingTransaction) {
                signTransactionIntents(recipe.balancingTransaction, signFn, "pre-proof");
            }
            return wallet.finalizeRecipe(recipe);
        },
        async submitTx(tx: ledger.FinalizedTransaction) {
            return wallet.submitTransaction(tx);
        },
    };
}

// ---------------------------------------------------------------------------
// Global state: wallet, providers, contract
// ---------------------------------------------------------------------------
let deployedContract: any = null;
let providers: any = null;
let walletAddress = "";
let isReady = false;
let initError: string | null = null;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
    try {
        setNetworkId(NETWORK_ID);
        logger.info("Building wallet...");

        const { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore } = await buildWallet(SEED);
        walletAddress = String(unshieldedKeystore.getBech32Address());
        logger.info(`Wallet address: ${walletAddress}`);

        logger.info("Syncing wallet...");
        const syncedState = await Rx.firstValueFrom(
            wallet.state().pipe(Rx.throttleTime(5_000), Rx.filter((s) => s.isSynced))
        );
        logger.info("Wallet synced!");

        const walletAndMidnightProvider = createWalletAndMidnightProvider(
            wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore, syncedState
        );

        const zkConfigProvider = new NodeZkConfigProvider<VotingCircuits>(zkConfigPath);

        providers = {
            privateStateProvider: levelPrivateStateProvider<typeof VotingPrivateStateId>({
                privateStateStoreName: "voting-private-state-server",
                signingKeyStoreName: "signing-keys-server",
                midnightDbName: "midnight-level-db-server",
                walletProvider: walletAndMidnightProvider,
            }),
            publicDataProvider: indexerPublicDataProvider(INDEXER, INDEXER_WS),
            zkConfigProvider,
            proofProvider: httpClientProofProvider(PROOF_SERVER, zkConfigProvider),
            walletProvider: walletAndMidnightProvider,
            midnightProvider: walletAndMidnightProvider,
        };

        logger.info("Joining deployed contract...");
        const votingCompiledContract = CompiledContract.make("voting", Contract).pipe(
            CompiledContract.withVacantWitnesses,
            CompiledContract.withCompiledFileAssets(zkConfigPath)
        );

        deployedContract = await findDeployedContract(providers, {
            contractAddress: CONTRACT_ADDRESS,
            compiledContract: votingCompiledContract,
            privateStateId: VotingPrivateStateId,
            initialPrivateState: {},
        });

        isReady = true;
        logger.info("✓ Server ready! Contract joined successfully.");
    } catch (err: any) {
        initError = err.message || String(err);
        logger.error(err, "Init failed");
    }
}

// ---------------------------------------------------------------------------
// REST API via raw http server
// ---------------------------------------------------------------------------
function json(res: http.ServerResponse, status: number, body: any) {
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
    });
}

const server = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === "OPTIONS") {
        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
    }

    const url = req.url ?? "/";

    try {
        // GET /api/status — check server readiness
        if (url === "/api/status" && req.method === "GET") {
            return json(res, 200, {
                ready: isReady,
                error: initError,
                walletAddress,
                contractAddress: CONTRACT_ADDRESS,
                network: NETWORK_ID,
            });
        }

        // GET /api/state — read current ledger state
        if (url === "/api/state" && req.method === "GET") {
            if (!isReady) return json(res, 503, { error: "Server not ready" });

            const contractState = await providers.publicDataProvider.queryContractState(CONTRACT_ADDRESS);
            if (!contractState) return json(res, 404, { error: "Contract state not found" });

            const state = votingLedger(contractState.data);
            return json(res, 200, {
                yes_votes: Number(state.yes_votes),
                no_votes: Number(state.no_votes),
                voters_count: Number(state.voters.size()),
                is_open: state.is_open,
            });
        }

        // POST /api/vote — cast a vote { choice: true/false }
        if (url === "/api/vote" && req.method === "POST") {
            if (!isReady) return json(res, 503, { error: "Server not ready" });

            const body = JSON.parse(await readBody(req));
            const choice = body.choice === true;

            // Generate a random voter ID (32 bytes)
            const crypto = await import("node:crypto");
            const voterId = crypto.randomBytes(32);

            logger.info(`Casting vote: ${choice ? "YES" : "NO"}`);
            const txData = await deployedContract.callTx.vote(voterId, choice);
            const txId = txData.public.txId;
            logger.info(`Vote tx submitted: ${txId}`);

            return json(res, 200, { txHash: txId, choice: choice ? "yes" : "no" });
        }

        // POST /api/open — open voting
        if (url === "/api/open" && req.method === "POST") {
            if (!isReady) return json(res, 503, { error: "Server not ready" });

            logger.info("Opening voting...");
            const txData = await deployedContract.callTx.open_voting();
            const txId = txData.public.txId;
            logger.info(`Open voting tx: ${txId}`);

            return json(res, 200, { txHash: txId });
        }

        // POST /api/close — close voting
        if (url === "/api/close" && req.method === "POST") {
            if (!isReady) return json(res, 503, { error: "Server not ready" });

            logger.info("Closing voting...");
            const txData = await deployedContract.callTx.close_voting();
            const txId = txData.public.txId;
            logger.info(`Close voting tx: ${txId}`);

            return json(res, 200, { txHash: txId });
        }

        // 404 fallback
        json(res, 404, { error: "Not found" });
    } catch (err: any) {
        logger.error(err, "Request error");
        json(res, 500, { error: err.message || String(err) });
    }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
server.listen(PORT, () => {
    logger.info(`API server listening on http://127.0.0.1:${PORT}`);
    logger.info("Initializing wallet and joining contract...");
    init();
});
