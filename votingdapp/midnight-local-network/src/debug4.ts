// Debug: check wallet sync state events - writes to file
import * as fs from 'node:fs';

const logFile = '/tmp/wallet-debug.log';
function log(msg: string) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(logFile, line);
    process.stderr.write(line);
}

async function main() {
    fs.writeFileSync(logFile, '');
    log('Starting...');
    
    const ledger = await import('@midnight-ntwrk/ledger-v7');
    const hd = await import('@midnight-ntwrk/wallet-sdk-hd');
    const shielded = await import('@midnight-ntwrk/wallet-sdk-shielded');
    const dust = await import('@midnight-ntwrk/wallet-sdk-dust-wallet');
    const unshielded = await import('@midnight-ntwrk/wallet-sdk-unshielded-wallet');
    const facadeMod = await import('@midnight-ntwrk/wallet-sdk-facade');
    const rx = await import('rxjs');
    log('Imports done');

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
    const ks = unshielded.createKeystore(dr.keys[hd.Roles.NightExternal], 'undeployed');
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
    };

    log('Creating wallets...');
    const sw = shielded.ShieldedWallet(cfg as any).startWithSecretKeys(shieldedSecretKeys);
    const dw = dust.DustWallet(cfg as any).startWithSecretKey(
        dustSecretKey, ledger.LedgerParameters.initialParameters().dust);
    const uw = unshielded.UnshieldedWallet({
        ...cfg,
        txHistoryStorage: new unshielded.InMemoryTransactionHistoryStorage(),
    } as any).startWithPublicKey(unshielded.PublicKey.fromKeyStore(ks));
    log('Wallets created');

    const wf = new facadeMod.WalletFacade(sw, uw, dw);
    log('Calling facade.start()...');
    await wf.start(shieldedSecretKeys, dustSecretKey);
    log('Facade started!');

    // Subscribe and watch for 90 seconds
    let eventCount = 0;
    const sub = wf.state().subscribe({
        next: (s: any) => {
            eventCount++;
            const bal = s.unshielded?.balances?.[ledger.nativeToken().raw] ?? 'N/A';
            log(`Event ${eventCount}: isSynced=${s.isSynced}, bal=${bal}`);
        },
        error: (err: any) => log(`State error: ${err}`),
        complete: () => log('State complete'),
    });

    // Also check individual wallet states
    setTimeout(async () => {
        log('--- Checking individual wallet states ---');
        try {
            // Check if shielded wallet has a state method
            if (typeof (sw as any).state === 'function') {
                const shState = await rx.firstValueFrom((sw as any).state().pipe(rx.take(1)));
                log(`Shielded state: ${JSON.stringify({isSynced: shState?.isSynced, keys: Object.keys(shState || {})})}`);
            }
        } catch(e: any) { log(`Shielded state error: ${e.message}`); }
        
        try {
            if (typeof (uw as any).state === 'function') {
                const uwState = await rx.firstValueFrom((uw as any).state().pipe(rx.take(1)));
                log(`Unshielded state: ${JSON.stringify({isSynced: uwState?.isSynced, keys: Object.keys(uwState || {})})}`);
            }
        } catch(e: any) { log(`Unshielded state error: ${e.message}`); }
        
        try {
            if (typeof (dw as any).state === 'function') {
                const dwState = await rx.firstValueFrom((dw as any).state().pipe(rx.take(1)));
                log(`Dust state: ${JSON.stringify({isSynced: dwState?.isSynced, keys: Object.keys(dwState || {})})}`);
            }
        } catch(e: any) { log(`Dust state error: ${e.message}`); }
    }, 10000);

    setTimeout(() => {
        sub.unsubscribe();
        log(`Total events received: ${eventCount}`);
        wf.stop().then(() => {
            log('Done');
            process.exit(0);
        });
    }, 90000);
}

main().catch(e => {
    const msg = `FATAL: ${e.stack || e}`;
    fs.appendFileSync('/tmp/wallet-debug.log', msg + '\n');
    process.stderr.write(msg + '\n');
    process.exit(1);
});
