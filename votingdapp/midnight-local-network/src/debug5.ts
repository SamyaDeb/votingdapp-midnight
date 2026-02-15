// Debug individual wallet components
import * as fs from 'node:fs';
const logFile = '/tmp/wallet-debug5.log';
function log(msg: string) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(logFile, line);
    process.stderr.write(line);
}

async function main() {
    fs.writeFileSync(logFile, '');
    log('Starting individual wallet component tests...');
    
    const ledger = await import('@midnight-ntwrk/ledger-v7');
    const hd = await import('@midnight-ntwrk/wallet-sdk-hd');
    const shieldedMod = await import('@midnight-ntwrk/wallet-sdk-shielded');
    const dustMod = await import('@midnight-ntwrk/wallet-sdk-dust-wallet');
    const unshieldedMod = await import('@midnight-ntwrk/wallet-sdk-unshielded-wallet');
    const rx = await import('rxjs');

    const genesisWalletSeed = Buffer.from(
        '0000000000000000000000000000000000000000000000000000000000000001', 'hex');
    const hdWallet = hd.HDWallet.fromSeed(Uint8Array.from(genesisWalletSeed));
    if (hdWallet.type !== 'seedOk') throw new Error('HDWallet fail');
    const dr = hdWallet.hdWallet.selectAccount(0)
        .selectRoles([hd.Roles.Zswap, hd.Roles.NightExternal, hd.Roles.Dust])
        .deriveKeysAt(0);
    if (dr.type !== 'keysDerived') throw new Error('derive fail');
    hdWallet.hdWallet.clear();

    const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(dr.keys[hd.Roles.Zswap]);
    const dustSecretKey = ledger.DustSecretKey.fromSeed(dr.keys[hd.Roles.Dust]);
    const ks = unshieldedMod.createKeystore(dr.keys[hd.Roles.NightExternal], 'undeployed');
    log(`Genesis address: ${ks.getBech32Address()}`);

    const cfg = {
        networkId: 'undeployed',
        costParameters: { additionalFeeOverhead: 300_000_000_000_000_000n, feeBlocksMargin: 5 },
        relayURL: new URL('ws://localhost:9944'),
        provingServerUrl: new URL('http://localhost:6300'),
        indexerClientConnection: {
            indexerHttpUrl: 'http://localhost:8088/api/v3/graphql',
            indexerWsUrl: 'ws://localhost:8088/api/v3/graphql/ws',
        },
        indexerUrl: 'ws://localhost:8088/api/v3/graphql/ws',
    };

    // Test 1: UnshieldedWallet alone
    log('--- Test 1: UnshieldedWallet ---');
    const uw = unshieldedMod.UnshieldedWallet({
        ...cfg,
        txHistoryStorage: new unshieldedMod.InMemoryTransactionHistoryStorage(),
    } as any).startWithPublicKey(unshieldedMod.PublicKey.fromKeyStore(ks));
    
    log(`UW type: ${typeof uw}`);
    log(`UW keys: ${Object.keys(uw).join(', ')}`);
    log(`UW methods: ${Object.getOwnPropertyNames(Object.getPrototypeOf(uw)).join(', ')}`);
    
    if (typeof uw.state === 'function') {
        log('UW has state() method');
        let uwEventCount = 0;
        const uwSub = uw.state().subscribe({
            next: (s: any) => {
                uwEventCount++;
                log(`UW event ${uwEventCount}: isSynced=${s.isSynced}, keys=${Object.keys(s).join(',')}`);
                if (s.balances) log(`UW balances: ${JSON.stringify(s.balances)}`);
                if (s.availableCoins) log(`UW coins: ${s.availableCoins?.length ?? 0}`);
            },
            error: (e: any) => log(`UW error: ${e}`),
        });
        
        // Wait 20s for unshielded wallet
        await new Promise(r => setTimeout(r, 20000));
        uwSub.unsubscribe();
        log(`UW total events: ${uwEventCount}`);
    } else {
        log('UW does NOT have state() method');
    }

    // Test 2: Check if 'waitForSyncedState' works
    if (typeof (uw as any).waitForSyncedState === 'function') {
        log('UW has waitForSyncedState() method');
        try {
            const timeout = Promise.race([
                (uw as any).waitForSyncedState(),
                new Promise((_, rej) => setTimeout(() => rej(new Error('waitForSyncedState timeout 15s')), 15000)),
            ]);
            const result = await timeout;
            log(`UW waitForSyncedState result: ${JSON.stringify(result).slice(0, 300)}`);
        } catch (e: any) {
            log(`UW waitForSyncedState error: ${e.message}`);
        }
    }

    // Test 3: ShieldedWallet
    log('--- Test 3: ShieldedWallet ---');
    const sw = shieldedMod.ShieldedWallet(cfg as any).startWithSecretKeys(shieldedSecretKeys);
    log(`SW type: ${typeof sw}`);
    if (typeof sw.state === 'function') {
        log('SW has state() method');
        let swEventCount = 0;
        const swSub = sw.state().subscribe({
            next: (s: any) => {
                swEventCount++;
                log(`SW event ${swEventCount}: keys=${Object.keys(s).join(',')}, isSynced=${s.isSynced}`);
            },
            error: (e: any) => log(`SW error: ${e}`),
        });
        await new Promise(r => setTimeout(r, 15000));
        swSub.unsubscribe();
        log(`SW total events: ${swEventCount}`);
    }

    if (typeof (sw as any).waitForSyncedState === 'function') {
        log('SW has waitForSyncedState()');
        try {
            await Promise.race([
                (sw as any).waitForSyncedState(),
                new Promise((_, rej) => setTimeout(() => rej(new Error('SW waitForSyncedState timeout')), 10000)),
            ]);
            log('SW synced!');
        } catch (e: any) {
            log(`SW waitForSyncedState: ${e.message}`);
        }
    }

    log('All tests done');
    process.exit(0);
}

main().catch(e => {
    log(`FATAL: ${e.stack || e}`);
    process.exit(1);
});
