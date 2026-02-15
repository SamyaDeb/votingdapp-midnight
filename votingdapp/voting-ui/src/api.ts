
import { Contract, ledger as votingLedger } from './managed/voting/contract/index';
// @ts-ignore
import {
    type DeployedContract,
    findDeployedContract,
} from '@midnight-ntwrk/midnight-js-contracts';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
// import { type ZkConfigProvider } from '@midnight-ntwrk/midnight-js-types'; // Not exported?
import { UnshieldedWallet, createKeystore, InMemoryTransactionHistoryStorage, PublicKey } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import * as ledger from '@midnight-ntwrk/ledger-v7';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import * as Rx from 'rxjs';
import { Buffer } from 'buffer';

// Polyfill Buffer
if (typeof window !== 'undefined') {
    window.Buffer = Buffer;
}

const INDEXER = 'http://127.0.0.1:8088/api/v3/graphql';
const INDEXER_WS = 'ws://127.0.0.1:8088/api/v3/graphql/ws';
const PROOF_SERVER = 'http://127.0.0.1:6300';
const NODE = 'http://127.0.0.1:9944';
const NETWORK_ID = 'undeployed';

setNetworkId(NETWORK_ID);

export type VotingContract = DeployedContract<Contract<any>>;

export interface VotingContractAPI {
    join: (contractAddress: string) => Promise<VotingContract>;
    vote: (contract: VotingContract, choice: boolean) => Promise<ledger.TransactionId>;
    openVoting: (contract: VotingContract) => Promise<ledger.TransactionId>;
    closeVoting: (contract: VotingContract) => Promise<ledger.TransactionId>;
}


import {
    type ZKConfigProvider,
    type ZKIR,
    type ProverKey,
    type VerifierKey,
    type ZKConfig,
} from '@midnight-ntwrk/midnight-js-types';

class FetchZkConfigProvider<K extends string> implements ZKConfigProvider<K> {
    private baseUrl: string;
    constructor(baseUrl: string) {
        this.baseUrl = baseUrl;
    }

    private async fetchBinary(path: string): Promise<Uint8Array> {
        const response = await fetch(`${this.baseUrl}/${path}`);
        if (!response.ok) {
            throw new Error(`Failed to fetch ${path}: ${response.statusText}`);
        }
        const buffer = await response.arrayBuffer();
        return new Uint8Array(buffer);
    }

    async getZKIR(circuitId: K): Promise<ZKIR> {
        const data = await this.fetchBinary(`zkir/${circuitId}.zkir`);
        return data as ZKIR;
    }

    async getProverKey(circuitId: K): Promise<ProverKey> {
        const data = await this.fetchBinary(`keys/${circuitId}.prover`);
        return data as ProverKey;
    }

    async getVerifierKey(circuitId: K): Promise<VerifierKey> {
        const data = await this.fetchBinary(`keys/${circuitId}.verifier`);
        return data as VerifierKey;
    }

    async getVerifierKeys(circuitIds: K[]): Promise<[K, VerifierKey][]> {
        const promises = circuitIds.map(async (id) => {
            const key = await this.getVerifierKey(id);
            return [id, key] as [K, VerifierKey];
        });
        return Promise.all(promises);
    }

    async get(circuitId: K): Promise<ZKConfig<K>> {
        const [zkir, proverKey, verifierKey] = await Promise.all([
            this.getZKIR(circuitId),
            this.getProverKey(circuitId),
            this.getVerifierKey(circuitId),
        ]);

        return {
            circuitId,
            zkir,
            proverKey,
            verifierKey,
        };
    }

    asKeyMaterialProvider() {
        // This is used by some internal components, implementing minimal interface
        return {
            getZKIR: (loc: string) => this.getZKIR(loc as K),
            getProverKey: (loc: string) => this.getProverKey(loc as K),
            getVerifierKey: (loc: string) => this.getVerifierKey(loc as K),
        }
    }
}

const zkConfigProvider = new FetchZkConfigProvider<string>('/managed/voting');

export const initAPI = async (seed: string) => {
    const keys = deriveKeysFromSeed(seed);
    const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
    const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
    const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], NETWORK_ID);

    const shieldedWallet = ShieldedWallet({
        networkId: NETWORK_ID,
        indexerClientConnection: { indexerHttpUrl: INDEXER, indexerWsUrl: INDEXER_WS },
        provingServerUrl: new URL(PROOF_SERVER),
        relayURL: new URL(NODE.replace(/^http/, 'ws')),
    }).startWithSecretKeys(shieldedSecretKeys);

    const unshieldedWallet = UnshieldedWallet({
        networkId: NETWORK_ID,
        indexerClientConnection: { indexerHttpUrl: INDEXER, indexerWsUrl: INDEXER_WS },
        txHistoryStorage: new InMemoryTransactionHistoryStorage(),
    } as any).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore));

    const dustWallet = DustWallet({
        networkId: NETWORK_ID,
        costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
        indexerClientConnection: { indexerHttpUrl: INDEXER, indexerWsUrl: INDEXER_WS },
        provingServerUrl: new URL(PROOF_SERVER),
        relayURL: new URL(NODE.replace(/^http/, 'ws')),
    }).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust);

    const wallet = new WalletFacade(shieldedWallet, unshieldedWallet, dustWallet);
    await wallet.start(shieldedSecretKeys, dustSecretKey);

    const state = await Rx.firstValueFrom(wallet.state());
    const coinPublicKey = state.shielded.coinPublicKey.toHexString();
    const encryptionPublicKey = state.shielded.encryptionPublicKey.toHexString();

    const walletAndMidnightProvider = {
        getCoinPublicKey: () => coinPublicKey,
        getEncryptionPublicKey: () => encryptionPublicKey,
        balanceTx: async (tx: any, ttl: any) => {
            const recipe = await wallet.balanceUnboundTransaction(
                tx,
                { shieldedSecretKeys, dustSecretKey },
                { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) }
            );
            const signFn = (payload: Uint8Array) => unshieldedKeystore.signData(payload);
            signTransactionIntents(recipe.baseTransaction, signFn, 'proof');
            if (recipe.balancingTransaction) {
                signTransactionIntents(recipe.balancingTransaction, signFn, 'pre-proof');
            }
            return wallet.finalizeRecipe(recipe);
        },
        submitTx: (tx: any) => wallet.submitTransaction(tx),
    };

    const providers = {
        privateStateProvider: levelPrivateStateProvider({
            privateStateStoreName: 'voting-private-state',
            signingKeyStoreName: 'signing-keys',
            midnightDbName: 'midnight-level-db',
            walletProvider: walletAndMidnightProvider,
        }),
        publicDataProvider: indexerPublicDataProvider(INDEXER, INDEXER_WS),
        zkConfigProvider: zkConfigProvider,
        proofProvider: httpClientProofProvider(PROOF_SERVER, zkConfigProvider),
        walletProvider: walletAndMidnightProvider,
        midnightProvider: walletAndMidnightProvider,
    };

    return { wallet, providers };
};


function deriveKeysFromSeed(seed: string) {
    const hdWallet = HDWallet.fromSeed(Buffer.from(seed, 'hex'));
    if (hdWallet.type !== 'seedOk') throw new Error('Failed to initialize HDWallet from seed');
    const result = hdWallet.hdWallet.selectAccount(0).selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust]).deriveKeysAt(0);
    if (result.type !== 'keysDerived') throw new Error('Failed to derive keys');
    hdWallet.hdWallet.clear();
    return result.keys;
}

function signTransactionIntents(
    tx: { intents?: Map<number, any> },
    signFn: (payload: Uint8Array) => ledger.Signature,
    proofMarker: 'proof' | 'pre-proof'
): void {
    if (!tx.intents || tx.intents.size === 0) return;
    for (const segment of tx.intents.keys()) {
        const intent = tx.intents.get(segment);
        if (!intent) continue;
        const cloned = ledger.Intent.deserialize(
            'signature',
            proofMarker,
            'pre-binding',
            intent.serialize()
        );
        const sigData = cloned.signatureData(segment);
        const signature = signFn(sigData);
        if (cloned.fallibleUnshieldedOffer) {
            const sigs = cloned.fallibleUnshieldedOffer.inputs.map(
                (_: any, i: number) => cloned.fallibleUnshieldedOffer!.signatures.at(i) ?? signature
            );
            cloned.fallibleUnshieldedOffer = cloned.fallibleUnshieldedOffer.addSignatures(sigs);
        }
        if (cloned.guaranteedUnshieldedOffer) {
            const sigs = cloned.guaranteedUnshieldedOffer.inputs.map(
                (_: any, i: number) => cloned.guaranteedUnshieldedOffer!.signatures.at(i) ?? signature
            );
            cloned.guaranteedUnshieldedOffer = cloned.guaranteedUnshieldedOffer.addSignatures(sigs);
        }
        tx.intents.set(segment, cloned);
    }
}

export const joinVotingContract = async (providers: any, address: string) => {
    // Cast strict type required by findDeployedContract
    const contract = await findDeployedContract(providers, {
        contractAddress: address,
        compiledContract: CompiledContract.make('voting', Contract).pipe(
            CompiledContract.withVacantWitnesses
        ) as any, // Cast to any to bypass generic constraints mismatch
        privateStateId: 'votingPrivateState',
        initialPrivateState: {},
    });
    return contract;
}

export const getLedgerState = (state: any) => {
    return votingLedger(state.data);
}
