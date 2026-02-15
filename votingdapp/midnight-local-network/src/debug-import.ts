// Test which import is hanging (using dynamic imports)
async function main() {
    console.log('[0] Script starting...');

    console.log('[1] Importing ledger-v7...');
    const ledger = await import('@midnight-ntwrk/ledger-v7');
    console.log('[1] ledger-v7 imported OK');

    console.log('[2] Importing wallet-sdk-hd...');
    const hd = await import('@midnight-ntwrk/wallet-sdk-hd');
    console.log('[2] wallet-sdk-hd imported OK');

    console.log('[3] Importing wallet-sdk-shielded...');
    const shielded = await import('@midnight-ntwrk/wallet-sdk-shielded');
    console.log('[3] wallet-sdk-shielded imported OK');

    console.log('[4] Importing wallet-sdk-dust-wallet...');
    const dust = await import('@midnight-ntwrk/wallet-sdk-dust-wallet');
    console.log('[4] wallet-sdk-dust-wallet imported OK');

    console.log('[5] Importing wallet-sdk-unshielded-wallet...');
    const unshielded = await import('@midnight-ntwrk/wallet-sdk-unshielded-wallet');
    console.log('[5] wallet-sdk-unshielded-wallet imported OK');

    console.log('[6] Importing wallet-sdk-facade...');
    const facade = await import('@midnight-ntwrk/wallet-sdk-facade');
    console.log('[6] wallet-sdk-facade imported OK');

    console.log('All imports done!');

    console.log('[7] Deriving keys from genesis seed...');
    const genesisWalletSeed = Buffer.from(
        '0000000000000000000000000000000000000000000000000000000000000001',
        'hex',
    );
    const hdWallet = hd.HDWallet.fromSeed(Uint8Array.from(genesisWalletSeed));
    if (hdWallet.type !== 'seedOk') throw new Error('HDWallet fail');
    const derivationResult = hdWallet.hdWallet
        .selectAccount(0)
        .selectRoles([hd.Roles.Zswap, hd.Roles.NightExternal, hd.Roles.Dust])
        .deriveKeysAt(0);
    if (derivationResult.type !== 'keysDerived') throw new Error('derive fail');
    hdWallet.hdWallet.clear();
    console.log('[7] Keys derived OK');

    const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(derivationResult.keys[hd.Roles.Zswap]);
    const dustSecretKey = ledger.DustSecretKey.fromSeed(derivationResult.keys[hd.Roles.Dust]);
    const ks = unshielded.createKeystore(derivationResult.keys[hd.Roles.NightExternal], 'undeployed');
    console.log('[8] Address:', ks.getBech32Address());

    console.log('[9] Creating ShieldedWallet...');
    const sw = shielded.ShieldedWallet({
        networkId: 'undeployed',
        costParameters: { additionalFeeOverhead: 300_000_000_000_000_000n, feeBlocksMargin: 5 },
        relayURL: new URL('ws://localhost:9944'),
        provingServerUrl: new URL('http://localhost:6300'),
        indexerClientConnection: {
            indexerHttpUrl: 'http://localhost:8088/api/v3/graphql',
            indexerWsUrl: 'ws://localhost:8088/api/v3/graphql/ws',
        },
    }).startWithSecretKeys(shieldedSecretKeys);
    console.log('[9] ShieldedWallet created OK');

    console.log('[10] Creating DustWallet...');
    const dw = dust.DustWallet({
        networkId: 'undeployed',
        costParameters: { additionalFeeOverhead: 300_000_000_000_000_000n, feeBlocksMargin: 5 },
        relayURL: new URL('ws://localhost:9944'),
        provingServerUrl: new URL('http://localhost:6300'),
        indexerClientConnection: {
            indexerHttpUrl: 'http://localhost:8088/api/v3/graphql',
            indexerWsUrl: 'ws://localhost:8088/api/v3/graphql/ws',
        },
    } as any).startWithSecretKey(
        dustSecretKey,
        ledger.LedgerParameters.initialParameters().dust,
    );
    console.log('[10] DustWallet created OK');

    console.log('[11] Creating UnshieldedWallet...');
    const uw = unshielded.UnshieldedWallet({
        networkId: 'undeployed',
        indexerClientConnection: {
            indexerHttpUrl: 'http://localhost:8088/api/v3/graphql',
            indexerWsUrl: 'ws://localhost:8088/api/v3/graphql/ws',
        },
        txHistoryStorage: new unshielded.InMemoryTransactionHistoryStorage(),
    }).startWithPublicKey(unshielded.PublicKey.fromKeyStore(ks));
    console.log('[11] UnshieldedWallet created OK');

    console.log('[12] Creating WalletFacade...');
    const wf = new facade.WalletFacade(sw, uw, dw);
    console.log('[12] WalletFacade created OK');

    console.log('[13] Starting WalletFacade (with 60s timeout)...');
    const startResult = await Promise.race([
        wf.start(shieldedSecretKeys, dustSecretKey).then(() => 'started'),
        new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 60000)),
    ]);
    console.log('[13] WalletFacade start result:', startResult);

    if (startResult === 'timeout') {
        console.log('[14] facade.start() timed out — checking state stream...');
        const stateResult = await Promise.race([
            (async () => {
                const { firstValueFrom, tap } = await import('rxjs');
                const s = await firstValueFrom(wf.state().pipe(tap(x => console.log('  state event:', JSON.stringify({ isSynced: x.isSynced })))));
                return s;
            })(),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 15000)),
        ]);
        console.log('[14] state result:', stateResult ? 'got state' : 'state also timed out');
        process.exit(1);
    }

    console.log('[15] Waiting for isSynced...');
    const { firstValueFrom, filter, tap } = await import('rxjs');
    const syncedState = await firstValueFrom(
        wf.state().pipe(
            tap((s) => console.log(`  synced: ${s.isSynced}`)),
            filter((s) => s.isSynced),
        ),
    );
    console.log('[16] Synced! Balance:', syncedState.unshielded?.balances[ledger.nativeToken().raw] ?? 0n);

    await wf.stop();
    console.log('[17] Done!');
    process.exit(0);
}

main().catch(e => {
    console.error('FATAL:', e);
    process.exit(1);
});
