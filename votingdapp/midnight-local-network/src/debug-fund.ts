/**
 * Debug script to isolate where the fund process hangs.
 */
import * as ledger from '@midnight-ntwrk/ledger-v7';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import {
    createKeystore,
    InMemoryTransactionHistoryStorage,
    PublicKey as UnshieldedPublicKey,
    UnshieldedWallet,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { Buffer } from 'buffer';
import * as rx from 'rxjs';

const INDEXER_HTTP_URL = 'http://localhost:8088/api/v3/graphql';
const INDEXER_WS_URL = 'ws://localhost:8088/api/v3/graphql/ws';
const NODE_URL = 'ws://localhost:9944';
const PROOF_SERVER_URL = 'http://localhost:6300';

async function main() {
    console.log('[1] Starting debug fund script...');
    
    const genesisWalletSeed = Buffer.from(
        '0000000000000000000000000000000000000000000000000000000000000001',
        'hex',
    );

    console.log('[2] Deriving keys from seed...');
    const hdWallet = HDWallet.fromSeed(Uint8Array.from(genesisWalletSeed));
    if (hdWallet.type !== 'seedOk') throw new Error('Failed to initialize HDWallet');

    const derivationResult = hdWallet.hdWallet
        .selectAccount(0)
        .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
        .deriveKeysAt(0);

    if (derivationResult.type !== 'keysDerived') throw new Error('Failed to derive keys');
    hdWallet.hdWallet.clear();
    console.log('[3] Keys derived successfully');

    const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(derivationResult.keys[Roles.Zswap]);
    const dustSecretKey = ledger.DustSecretKey.fromSeed(derivationResult.keys[Roles.Dust]);
    const unshieldedKeystore = createKeystore(derivationResult.keys[Roles.NightExternal], 'undeployed');
    console.log('[4] Keystore created. Address:', unshieldedKeystore.getBech32Address());

    console.log('[5] Creating ShieldedWallet...');
    const shieldedWallet = ShieldedWallet({
        networkId: 'undeployed',
        costParameters: {
            additionalFeeOverhead: 300_000_000_000_000_000n,
            feeBlocksMargin: 5,
        },
        relayURL: new URL(NODE_URL),
        provingServerUrl: new URL(PROOF_SERVER_URL),
        indexerClientConnection: {
            indexerHttpUrl: INDEXER_HTTP_URL,
            indexerWsUrl: INDEXER_WS_URL,
        },
    }).startWithSecretKeys(shieldedSecretKeys);
    console.log('[6] ShieldedWallet created');

    console.log('[7] Creating DustWallet...');
    const dustWallet = DustWallet({
        networkId: 'undeployed',
        costParameters: {
            additionalFeeOverhead: 300_000_000_000_000_000n,
            feeBlocksMargin: 5,
        },
        relayURL: new URL(NODE_URL),
        provingServerUrl: new URL(PROOF_SERVER_URL),
        indexerClientConnection: {
            indexerHttpUrl: INDEXER_HTTP_URL,
            indexerWsUrl: INDEXER_WS_URL,
        },
    } as any).startWithSecretKey(
        dustSecretKey,
        ledger.LedgerParameters.initialParameters().dust,
    );
    console.log('[8] DustWallet created');

    console.log('[9] Creating UnshieldedWallet...');
    const unshieldedWallet = UnshieldedWallet({
        networkId: 'undeployed',
        indexerClientConnection: {
            indexerHttpUrl: INDEXER_HTTP_URL,
            indexerWsUrl: INDEXER_WS_URL,
        },
        txHistoryStorage: new InMemoryTransactionHistoryStorage(),
    }).startWithPublicKey(UnshieldedPublicKey.fromKeyStore(unshieldedKeystore));
    console.log('[10] UnshieldedWallet created');

    console.log('[11] Creating WalletFacade...');
    const facade = new WalletFacade(shieldedWallet, unshieldedWallet, dustWallet);
    console.log('[12] Starting WalletFacade...');
    
    // Add a timeout to facade.start
    const startPromise = facade.start(shieldedSecretKeys, dustSecretKey);
    const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('facade.start() timed out after 30s')), 30000)
    );
    
    try {
        await Promise.race([startPromise, timeoutPromise]);
        console.log('[13] WalletFacade started successfully');
    } catch (err) {
        console.error('[13] WalletFacade.start() failed/timed out:', err);
        
        // Try to get state anyway
        console.log('[14] Attempting to get wallet state...');
        const stateTimeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('state timed out')), 10000)
        );

        try {
            const state = await Promise.race([
                rx.firstValueFrom(facade.state()),
                stateTimeout,
            ]);
            console.log('[15] Got state:', JSON.stringify({
                isSynced: (state as any).isSynced,
                hasShielded: !!(state as any).shielded,
                hasUnshielded: !!(state as any).unshielded,
                hasDust: !!(state as any).dust,
            }));
        } catch (e2) {
            console.error('[15] Could not get state:', e2);
        }
        
        process.exit(1);
    }

    console.log('[16] Waiting for sync...');
    const syncedState = await rx.firstValueFrom(
        facade.state().pipe(
            rx.tap((s) => console.log(`  sync status: ${s.isSynced}`)),
            rx.filter((s) => s.isSynced),
        ),
    );
    console.log('[17] Synced!');

    const bal = syncedState.unshielded?.balances[ledger.nativeToken().raw] ?? 0n;
    console.log(`[18] Genesis balance: ${bal}`);

    await facade.stop();
    console.log('[19] Done');
    process.exit(0);
}

main().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
});
